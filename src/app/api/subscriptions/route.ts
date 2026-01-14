import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../db';
import { subscriptions } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export async function GET(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const sub = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
    
    if (sub.length === 0) {
        return NextResponse.json(null);
    }

    const s = sub[0];
    return NextResponse.json({
      productId: s.productId,
      currentPeriodStart: s.currentPeriodStart,
      expiresAt: s.expiresAt,
      isTrial: s.isTrial,
      isActive: s.isActive,
      autoRenewStatus: s.autoRenewStatus,
      updatedAt: s.updatedAt,
    });

  } catch (error) {
    console.error('[SUBSCRIPTIONS_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
