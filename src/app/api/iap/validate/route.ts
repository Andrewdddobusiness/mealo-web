import { NextResponse } from 'next/server';
import { randomUUID, createHash } from 'crypto';
import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { isBodyTooLarge } from '@/lib/validation';
import { GooglePlayValidationError, validateGooglePlaySubscription } from '@/lib/googlePlay';

const APPLE_VERIFY_RECEIPT_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const SHARED_SECRET = process.env.APPLE_SHARED_SECRET;

const MAX_RECEIPT_LENGTH = 200_000; // bytes/chars (base64 string)
const MAX_ANDROID_PURCHASE_TOKEN_LENGTH = 4_096;
const MAX_ANDROID_PRODUCT_ID_LENGTH = 200;
const GOOGLE_PLAY_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME;

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_REQUESTS = 12;
const rateLimitByUser = new Map<string, { resetAtMs: number; count: number }>();

function mask(value: string, prefix = 6, suffix = 4) {
  if (!value) return '';
  if (value.length <= prefix + suffix) return value;
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`;
}

function isRetryableAppleStatus(status: unknown): boolean {
  const code = typeof status === 'number' ? status : Number(status);
  if (!Number.isFinite(code)) return false;
  // Apple docs: 21005 = receipt server unavailable.
  // 21100-21199 = internal data access errors (often transient).
  return code === 21005 || (code >= 21100 && code <= 21199);
}

function jsonError(status: number, payload: Record<string, unknown>, requestId: string) {
  const res = NextResponse.json({ ...payload, requestId }, { status });
  res.headers.set('x-request-id', requestId);
  res.headers.set('cache-control', 'no-store');
  return res;
}

export async function POST(request: Request) {
  const requestId = randomUUID();

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return jsonError(401, { error: 'Unauthorized' }, requestId);
    }

    if (isBodyTooLarge(request, 250_000)) {
      return jsonError(413, { error: 'Payload too large' }, requestId);
    }

    const nowMs = Date.now();
    const existing = rateLimitByUser.get(userId);
    if (!existing || existing.resetAtMs <= nowMs) {
      rateLimitByUser.set(userId, { resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS, count: 1 });
    } else if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
      const res = jsonError(
        429,
        { error: 'Too many requests. Please try again later.' },
        requestId,
      );
      res.headers.set('retry-after', String(retryAfterSeconds));
      return res;
    } else {
      existing.count += 1;
      rateLimitByUser.set(userId, existing);
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const platformRaw = typeof body?.platform === 'string' ? body.platform.trim() : '';
    const platform: 'ios' | 'android' = platformRaw === 'android' ? 'android' : 'ios';
    const receipt = typeof body?.receipt === 'string' ? body.receipt.trim() : '';
    const claimedUserId = typeof body?.userId === 'string' ? body.userId.trim() : null;
    const requestedProductId = typeof body?.productId === 'string' ? body.productId.trim() : '';
    const packageName = typeof body?.packageName === 'string' ? body.packageName.trim() : '';

    if (claimedUserId && claimedUserId !== userId) {
      return jsonError(403, { error: 'Forbidden' }, requestId);
    }

    if (!receipt) {
      return jsonError(400, { error: 'Missing receipt' }, requestId);
    }

    if (platform === 'android') {
      if (receipt.length > MAX_ANDROID_PURCHASE_TOKEN_LENGTH) {
        return jsonError(413, { error: 'Receipt is too large' }, requestId);
      }

      if (!requestedProductId) {
        return jsonError(400, { error: 'Missing productId' }, requestId);
      }
      if (requestedProductId.length > MAX_ANDROID_PRODUCT_ID_LENGTH) {
        return jsonError(413, { error: 'productId is too large' }, requestId);
      }

      if (!GOOGLE_PLAY_PACKAGE_NAME) {
        console.error('[IAP_VALIDATE] GOOGLE_PLAY_PACKAGE_NAME is not set', { requestId });
        return jsonError(
          500,
          { error: 'Server misconfigured: Android receipt validation unavailable.' },
          requestId,
        );
      }

      if (packageName && packageName !== GOOGLE_PLAY_PACKAGE_NAME) {
        return jsonError(400, { error: 'Invalid packageName' }, requestId);
      }

      console.log('[IAP_VALIDATE] request', {
        requestId,
        userId: mask(userId),
        platform,
        receiptLen: receipt.length,
        productId: requestedProductId,
      });

      if (!db) {
        throw new Error('Database connection not available');
      }

      const tokenHash = createHash('sha256').update(receipt).digest('hex');
      const originalTransactionId = `google:token:${tokenHash}`;

      const existingForToken = await db
        .select({ userId: subscriptions.userId })
        .from(subscriptions)
        .where(eq(subscriptions.originalTransactionId, originalTransactionId))
        .limit(1);
      if (existingForToken.length && existingForToken[0].userId !== userId) {
        return jsonError(409, { error: 'Receipt already linked to another account.' }, requestId);
      }

      let googleStatus: {
        currentPeriodStart: Date | null;
        expiresAt: Date;
        isTrial: boolean;
        isActive: boolean;
        autoRenewStatus: boolean;
      };
      try {
        googleStatus = await validateGooglePlaySubscription({
          packageName: GOOGLE_PLAY_PACKAGE_NAME,
          subscriptionId: requestedProductId,
          purchaseToken: receipt,
        });
      } catch (err: unknown) {
        if (err instanceof GooglePlayValidationError) {
          return jsonError(
            err.status,
            { error: err.message, retryable: err.retryable || undefined },
            requestId,
          );
        }
        throw err;
      }

      await db
        .insert(subscriptions)
        .values({
          userId,
          originalTransactionId,
          productId: requestedProductId,
          currentPeriodStart: googleStatus.currentPeriodStart,
          expiresAt: googleStatus.expiresAt,
          isTrial: googleStatus.isTrial,
          isActive: googleStatus.isActive,
          autoRenewStatus: googleStatus.autoRenewStatus,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: subscriptions.userId,
          set: {
            originalTransactionId,
            productId: requestedProductId,
            currentPeriodStart: googleStatus.currentPeriodStart,
            expiresAt: googleStatus.expiresAt,
            isTrial: googleStatus.isTrial,
            isActive: googleStatus.isActive,
            autoRenewStatus: googleStatus.autoRenewStatus,
            updatedAt: new Date(),
          },
        });

      const res = NextResponse.json(
        {
          success: true,
          subscription: {
            productId: requestedProductId,
            expiresAt: googleStatus.expiresAt,
            isTrial: googleStatus.isTrial,
            isActive: googleStatus.isActive,
          },
        },
        { status: 200 },
      );
      res.headers.set('x-request-id', requestId);
      res.headers.set('cache-control', 'no-store');
      return res;
    }

    if (receipt.length > MAX_RECEIPT_LENGTH) {
      return jsonError(413, { error: 'Receipt is too large' }, requestId);
    }

    console.log('[IAP_VALIDATE] request', { requestId, userId: mask(userId), platform, receiptLen: receipt.length });

    if (!SHARED_SECRET) {
      console.error('[IAP_VALIDATE] APPLE_SHARED_SECRET is not set', { requestId });
      return jsonError(
        500,
        { error: 'Server misconfigured: receipt validation unavailable.' },
        requestId,
      );
    }

    // 1. Validate with Apple (Production first)
    let validationEnv: 'production' | 'sandbox' = 'production';
    let appleResponse = await validateReceipt(receipt, APPLE_VERIFY_RECEIPT_URL);

    // 2. If status is 21007, retry with Sandbox
    if (appleResponse.status === 21007) {
      console.log('Production receipt validation failed with 21007, retrying sandbox...');
      validationEnv = 'sandbox';
      appleResponse = await validateReceipt(receipt, APPLE_SANDBOX_URL);
    }

    // 21006 means the receipt is valid but the subscription is expired.
    // We still want to parse it and store isActive=false so the app can reflect cancellation/expiry.
    const isExpiredButValid = appleResponse.status === 21006;

    if (appleResponse.status !== 0 && !isExpiredButValid) {
      console.error('[IAP_VALIDATE] Apple validation failed', {
        userId: mask(userId),
        env: validationEnv,
        status: appleResponse.status,
      });

      if (isRetryableAppleStatus(appleResponse.status)) {
        return jsonError(
          503,
          {
            error: 'Receipt validation temporarily unavailable. Please try again.',
            status: appleResponse.status,
            retryable: true,
          },
          requestId,
        );
      }

      return jsonError(
        400,
        { error: 'Receipt validation failed', status: appleResponse.status },
        requestId,
      );
    }

    // 3. Parse receipt info (pick the most recent transaction by expiry time)
    const latestReceiptInfo = [...(appleResponse.latest_receipt_info ?? [])].sort((a: any, b: any) => {
      const aMs = Number(a?.expires_date_ms ?? 0);
      const bMs = Number(b?.expires_date_ms ?? 0);
      return bMs - aMs;
    })[0];
    if (!latestReceiptInfo) {
      return jsonError(400, { error: 'No receipt info found' }, requestId);
    }

    const expiresDateMs = parseInt(latestReceiptInfo.expires_date_ms, 10);
    const expiresAt = new Date(expiresDateMs);
    const purchaseDateMs = Number.parseInt(String(latestReceiptInfo.purchase_date_ms ?? ''), 10);
    const currentPeriodStart = Number.isFinite(purchaseDateMs) && purchaseDateMs > 0 ? new Date(purchaseDateMs) : null;
    const productId = latestReceiptInfo.product_id;
    const originalTransactionId = latestReceiptInfo.original_transaction_id;
    // Trial / introductory offer detection (Apple returns strings "true"/"false").
    // For free trials, `is_trial_period` is typically "true". Some receipts may instead
    // indicate an introductory offer period via `is_in_intro_offer_period`.
    const isTrial =
      latestReceiptInfo.is_trial_period === 'true' || latestReceiptInfo.is_in_intro_offer_period === 'true';
    const isActive = expiresAt > new Date();

    if (!db) {
      throw new Error('Database connection not available');
    }

    console.log('[IAP_VALIDATE] parsed', {
      requestId,
      userId: mask(userId),
      env: validationEnv,
      productId,
      currentPeriodStart: currentPeriodStart ? currentPeriodStart.toISOString() : 'n/a',
      expiresAt: expiresAt.toISOString(),
      isTrial,
      isActive,
      originalTransactionId: mask(originalTransactionId),
    });

    const existingForTransaction = await db
      .select({ userId: subscriptions.userId })
      .from(subscriptions)
      .where(eq(subscriptions.originalTransactionId, originalTransactionId))
      .limit(1);
    if (existingForTransaction.length && existingForTransaction[0].userId !== userId) {
      return jsonError(409, { error: 'Receipt already linked to another account.' }, requestId);
    }

    // 4. Update Database
    try {
      await db
        .insert(subscriptions)
        .values({
          userId,
          originalTransactionId,
          productId,
          currentPeriodStart,
          expiresAt,
          isTrial,
          isActive,
          autoRenewStatus: true, // Simplified, ideally check pending_renewal_info
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: subscriptions.userId,
          set: {
            originalTransactionId,
            productId,
            currentPeriodStart,
            expiresAt,
            isTrial,
            isActive,
            autoRenewStatus: true,
            updatedAt: new Date(),
          },
        });
      console.log('[IAP_VALIDATE] upserted subscription', { requestId, userId: mask(userId), productId });
    } catch (dbError) {
      console.error('[IAP_VALIDATE] failed to upsert subscription', { requestId, userId: mask(userId), productId, dbError });
      throw dbError;
    }

    const res = NextResponse.json(
      {
        success: true,
        subscription: {
          productId,
          currentPeriodStart,
          expiresAt,
          isTrial,
          isActive,
        },
      },
      { status: 200 },
    );
    res.headers.set('x-request-id', requestId);
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error: unknown) {
    console.error('[IAP_VALIDATE] Error validating receipt', { requestId, error });
    return jsonError(500, { error: 'Internal Server Error' }, requestId);
  }
}

async function validateReceipt(receipt: string, url: string, attempt = 0): Promise<any> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        'receipt-data': receipt,
        password: SHARED_SECRET,
        'exclude-old-transactions': true,
      }),
    });

    const json = await response.json();
    const status = json?.status;
    if (isRetryableAppleStatus(status) && attempt < 2) {
      const delayMs = 250 * (attempt + 1);
      console.warn('[IAP_VALIDATE] retrying Apple verifyReceipt', { attempt: attempt + 1, delayMs, status });
      await new Promise((r) => setTimeout(r, delayMs));
      return validateReceipt(receipt, url, attempt + 1);
    }
    return json;
  } catch (error) {
    if (attempt < 2) {
      const delayMs = 250 * (attempt + 1);
      console.warn('[IAP_VALIDATE] verifyReceipt request failed, retrying', { attempt: attempt + 1, delayMs, error });
      await new Promise((r) => setTimeout(r, delayMs));
      return validateReceipt(receipt, url, attempt + 1);
    }
    throw error;
  }
}
