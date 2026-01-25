import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '@/db';
import { syncUserAchievements } from '@/lib/achievements/engine';

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

    const { achievements } = await syncUserAchievements(db, userId);
    const res = NextResponse.json({ achievements }, { status: 200 });
    res.headers.set('x-request-id', requestId);
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    console.error('[ACHIEVEMENTS_GET]', { requestId, error });
    return jsonError(500, 'internal_error', 'Something went wrong fetching achievements.', requestId);
  }
}

