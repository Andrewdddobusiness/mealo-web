import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { db } from '@/db';
import { runNotificationReminderSweep } from '@/lib/notifications/reminders';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function POST(req: Request) {
  const requestId = randomUUID();
  try {
    const secretExpected = process.env.NOTIFICATIONS_RUN_SECRET || '';
    if (!secretExpected) {
      return NextResponse.json({ error: 'server_misconfigured', requestId }, { status: 500 });
    }

    const url = new URL(req.url);
    const secretHeader = req.headers.get('x-notifications-secret') ?? '';
    const secretQuery = url.searchParams.get('secret') ?? '';
    const provided = secretHeader || secretQuery;

    if (!provided || !timingSafeEqual(provided, secretExpected)) {
      return NextResponse.json({ error: 'unauthorized', requestId }, { status: 401 });
    }

    if (!db) {
      return NextResponse.json({ error: 'server_misconfigured', requestId }, { status: 500 });
    }

    const result = await runNotificationReminderSweep(db);
    const res = NextResponse.json({ ok: true, requestId, result }, { status: 200 });
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    console.error('[NOTIFICATIONS_RUN]', { requestId, error });
    const res = NextResponse.json({ error: 'internal_error', requestId }, { status: 500 });
    res.headers.set('cache-control', 'no-store');
    return res;
  }
}

