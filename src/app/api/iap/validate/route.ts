import { NextResponse } from 'next/server';
import { db } from '@/db';
import { subscriptions } from '@/db/schema';

const APPLE_VERIFY_RECEIPT_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const SHARED_SECRET = process.env.APPLE_SHARED_SECRET;

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

export async function POST(request: Request) {
  try {
    const { receipt, userId } = await request.json();

    if (!receipt || !userId) {
      return NextResponse.json({ error: 'Missing receipt or userId' }, { status: 400 });
    }

    console.log('[IAP_VALIDATE] request', { userId: mask(userId), receiptLen: String(receipt).length });

    if (!SHARED_SECRET) {
      console.error('APPLE_SHARED_SECRET is not set');
      return NextResponse.json(
        {
          error:
            'Server misconfigured: APPLE_SHARED_SECRET is not set. Configure your App Store Connect app-specific shared secret on the server to validate subscriptions.',
        },
        { status: 500 },
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
        return NextResponse.json(
          {
            error: 'Receipt validation temporarily unavailable. Please try again.',
            status: appleResponse.status,
            retryable: true,
          },
          { status: 503 },
        );
      }

      return NextResponse.json({ error: 'Receipt validation failed', status: appleResponse.status }, { status: 400 });
    }

    // 3. Parse receipt info (pick the most recent transaction by expiry time)
    const latestReceiptInfo = [...(appleResponse.latest_receipt_info ?? [])].sort((a: any, b: any) => {
      const aMs = Number(a?.expires_date_ms ?? 0);
      const bMs = Number(b?.expires_date_ms ?? 0);
      return bMs - aMs;
    })[0];
    if (!latestReceiptInfo) {
      return NextResponse.json({ error: 'No receipt info found' }, { status: 400 });
    }

    const expiresDateMs = parseInt(latestReceiptInfo.expires_date_ms, 10);
    const expiresAt = new Date(expiresDateMs);
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
      userId: mask(userId),
      env: validationEnv,
      productId,
      expiresAt: expiresAt.toISOString(),
      isTrial,
      isActive,
      originalTransactionId: mask(originalTransactionId),
    });

    // 4. Update Database
    try {
      await db
        .insert(subscriptions)
        .values({
          userId,
          originalTransactionId,
          productId,
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
            expiresAt,
            isTrial,
            isActive,
            updatedAt: new Date(),
          },
        });
      console.log('[IAP_VALIDATE] upserted subscription', { userId: mask(userId), productId });
    } catch (dbError) {
      console.error('[IAP_VALIDATE] failed to upsert subscription', { userId: mask(userId), productId, dbError });
      throw dbError;
    }

    return NextResponse.json({
      success: true,
      subscription: {
        productId,
        expiresAt,
        isTrial,
        isActive,
      },
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    console.error('Error validating receipt:', error);
    return NextResponse.json({ error: message }, { status: 500 });
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
