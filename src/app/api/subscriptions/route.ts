import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../db';
import { subscriptions, users } from '../../../db/schema';
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

    const [userRow, subRow] = await Promise.all([
      db
        .select({ proOverride: users.proOverride })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    const hasProOverride = Boolean(userRow?.proOverride);
    const now = new Date();
    const subscriptionExpiresAt = subRow?.expiresAt instanceof Date ? subRow.expiresAt : null;
    const subscriptionIsActive =
      Boolean(subRow?.isActive) && Boolean(subscriptionExpiresAt && subscriptionExpiresAt > now);
    
    if (!subRow && !hasProOverride) {
      return NextResponse.json(null);
    }

    const effectiveIsActive = hasProOverride || subscriptionIsActive;
    const effectiveIsTrial = !hasProOverride && subscriptionIsActive && Boolean(subRow?.isTrial);
    const effectiveExpiresAt = subscriptionIsActive ? subscriptionExpiresAt : hasProOverride ? null : subscriptionExpiresAt;

    return NextResponse.json({
      productId: subRow?.productId ?? 'pro_override',
      currentPeriodStart: subRow?.currentPeriodStart ?? null,
      expiresAt: effectiveExpiresAt,
      isTrial: effectiveIsTrial,
      isActive: effectiveIsActive,
      autoRenewStatus: Boolean(subRow?.autoRenewStatus),
      updatedAt: subRow?.updatedAt ?? new Date(),
      proOverride: hasProOverride,
    });

  } catch (error) {
    console.error('[SUBSCRIPTIONS_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
