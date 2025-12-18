import { NextResponse } from 'next/server';
import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';

const APPLE_VERIFY_RECEIPT_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const SHARED_SECRET = process.env.APPLE_SHARED_SECRET;

export async function POST(request: Request) {
  try {
    const { receipt, userId } = await request.json();

    if (!receipt || !userId) {
      return NextResponse.json({ error: 'Missing receipt or userId' }, { status: 400 });
    }

    if (!SHARED_SECRET) {
      console.error('APPLE_SHARED_SECRET is not set');
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // 1. Validate with Apple (Production first)
    let appleResponse = await validateReceipt(receipt, APPLE_VERIFY_RECEIPT_URL);

    // 2. If status is 21007, retry with Sandbox
    if (appleResponse.status === 21007) {
      console.log('Production receipt validation failed with 21007, retrying sandbox...');
      appleResponse = await validateReceipt(receipt, APPLE_SANDBOX_URL);
    }

    if (appleResponse.status !== 0) {
      console.error('Apple validation failed', appleResponse);
      return NextResponse.json({ error: 'Receipt validation failed', status: appleResponse.status }, { status: 400 });
    }

    // 3. Parse receipt info
    const latestReceiptInfo = appleResponse.latest_receipt_info?.[0];
    if (!latestReceiptInfo) {
      return NextResponse.json({ error: 'No receipt info found' }, { status: 400 });
    }

    const expiresDateMs = parseInt(latestReceiptInfo.expires_date_ms, 10);
    const expiresAt = new Date(expiresDateMs);
    const productId = latestReceiptInfo.product_id;
    const originalTransactionId = latestReceiptInfo.original_transaction_id;
    const isTrial = latestReceiptInfo.is_trial_period === 'true';
    const isActive = expiresAt > new Date();

    if (!db) {
      throw new Error('Database connection not available');
    }

    // 4. Update Database
    await db.insert(subscriptions).values({
      userId,
      originalTransactionId,
      productId,
      expiresAt,
      isTrial,
      isActive,
      autoRenewStatus: true, // Simplified, ideally check pending_renewal_info
      updatedAt: new Date(),
    }).onConflictDoUpdate({
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

    return NextResponse.json({
      success: true,
      subscription: {
        productId,
        expiresAt,
        isTrial,
        isActive,
      },
    });

  } catch (error: any) {
    console.error('Error validating receipt:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}

async function validateReceipt(receipt: string, url: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'receipt-data': receipt,
      password: SHARED_SECRET,
      'exclude-old-transactions': true,
    }),
  });
  return await response.json();
}
