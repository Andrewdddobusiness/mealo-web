import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '@/db';
import { subscriptions } from '@/db/schema';
import { getAiUsageForPeriod, getCurrentAiUsagePeriod } from '@/lib/ai/aiUsage';

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

    const period = getCurrentAiUsagePeriod();
    const [subscription] = await database
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1);

    const features = await getAiUsageForPeriod(database, userId, period);

    const res = NextResponse.json(
      {
        isPro: Boolean(subscription?.isActive),
        period: {
          key: period.key,
          startsAt: period.startsAt.toISOString(),
          endsAt: period.endsAt.toISOString(),
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

