import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '@/db';
import { subscriptions, users } from '@/db/schema';
import { getAiCreditCost, getAiCreditsForPeriod, getAiUsageForPeriod, getAiUsagePeriodForSubscription } from '@/lib/ai/aiUsage';

function jsonError(status: number, error: string, message: string, requestId: string) {
  const res = NextResponse.json({ error, message, requestId }, { status });
  res.headers.set('x-request-id', requestId);
  res.headers.set('cache-control', 'no-store');
  return res;
}

export async function GET(req: Request) {
  const requestId = randomUUID();

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return jsonError(401, 'unauthorized', 'You must be signed in.', requestId);
    }

    if (!db) {
      return jsonError(500, 'server_misconfigured', 'Database is not configured.', requestId);
    }
    const database = db;

    const [userRow, subscription] = await Promise.all([
      database
        .select({ proOverride: users.proOverride })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      database
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    const hasProOverride = Boolean(userRow?.proOverride);

    const now = new Date();
    const subscriptionExpiresAt = subscription?.expiresAt instanceof Date ? subscription.expiresAt : null;
    const subscriptionIsActive =
      Boolean(subscription?.isActive) && Boolean(subscriptionExpiresAt && subscriptionExpiresAt > now);
    const isActive = hasProOverride || subscriptionIsActive;
    const tier =
      isActive ? (!hasProOverride && subscriptionIsActive && subscription?.isTrial ? 'trial' : 'pro') : 'free';
    const period = getAiUsagePeriodForSubscription({ subscription, now });

    const features = await getAiUsageForPeriod(database, userId, period, { tier });
    const credits = await getAiCreditsForPeriod(database, userId, period, { tier });

    const res = NextResponse.json(
      {
        isPro: isActive,
        tier,
        period: {
          key: period.key,
          startsAt: period.startsAt.toISOString(),
          endsAt: period.endsAt.toISOString(),
        },
        credits,
        creditCosts: {
          ai_generate_meal: getAiCreditCost('ai_generate_meal'),
          ai_scan_meal: getAiCreditCost('ai_scan_meal'),
          ai_import_video_meal: getAiCreditCost('ai_import_video_meal'),
        },
        features,
      },
      { status: 200 },
    );
    res.headers.set('x-request-id', requestId);
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    console.error('[AI_USAGE_GET]', { requestId, error });
    return jsonError(500, 'internal_error', 'Something went wrong fetching usage.', requestId);
  }
}
