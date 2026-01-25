import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '@/db';
import { notificationSettings, pushTokens } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

const DEFAULT_SETTINGS = {
  enabled: false,
  householdId: null as string | null,
  utcOffsetMinutes: 0,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  maxPerDay: 1,
  reminderTypes: {
    todayMissing: true,
    tomorrowMissing: true,
    missYou: true,
  },
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeExpoPushToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 256) return null;
  const ok = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(trimmed);
  return ok ? trimmed : null;
}

async function resolveHouseholdId(database: NonNullable<typeof db>, userId: string, requested: unknown): Promise<string | null> {
  const requestedId = typeof requested === 'string' && requested.trim().length > 0 ? requested.trim() : '';
  if (!requestedId) return null;

  const res = await database.execute(sql`
    SELECT household_id AS id
    FROM household_members
    WHERE user_id = ${userId}
      AND household_id = ${requestedId}
    LIMIT 1
  `);
  const row = (res.rows ?? [])[0] as { id?: unknown } | undefined;
  return typeof row?.id === 'string' && row.id.length > 0 ? row.id : null;
}

export async function GET(req: Request) {
  const requestId = randomUUID();
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }
    const database = db;

    const rows = await database.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).limit(1);
    const existing = rows[0] ?? null;

    if (existing) {
      const now = new Date();
      await database
        .update(notificationSettings)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(eq(notificationSettings.userId, userId));
    }

    const payload = existing
      ? {
          enabled: Boolean(existing.enabled),
          householdId: existing.householdId ?? null,
          utcOffsetMinutes: typeof existing.utcOffsetMinutes === 'number' ? existing.utcOffsetMinutes : DEFAULT_SETTINGS.utcOffsetMinutes,
          quietHoursStart: typeof existing.quietHoursStart === 'number' ? existing.quietHoursStart : DEFAULT_SETTINGS.quietHoursStart,
          quietHoursEnd: typeof existing.quietHoursEnd === 'number' ? existing.quietHoursEnd : DEFAULT_SETTINGS.quietHoursEnd,
          maxPerDay: typeof existing.maxPerDay === 'number' ? existing.maxPerDay : DEFAULT_SETTINGS.maxPerDay,
          reminderTypes: {
            todayMissing: Boolean(existing.remindTodayMissing),
            tomorrowMissing: Boolean(existing.remindTomorrowMissing),
            missYou: Boolean(existing.remindMissYou),
          },
        }
      : DEFAULT_SETTINGS;

    const res = NextResponse.json(payload, { status: 200 });
    res.headers.set('x-request-id', requestId);
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    console.error('[NOTIFICATION_SETTINGS_GET]', { requestId, error });
    const res = NextResponse.json({ error: 'internal_error', requestId }, { status: 500 });
    res.headers.set('x-request-id', requestId);
    res.headers.set('cache-control', 'no-store');
    return res;
  }
}

export async function PUT(req: Request) {
  const requestId = randomUUID();
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }
    const database = db;

    const body = (await req.json().catch(() => null)) as any;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'invalid_request', message: 'Expected JSON body.', requestId }, { status: 400 });
    }

    const enabled = parseBoolean(body.enabled, DEFAULT_SETTINGS.enabled);
    const utcOffsetMinutes = clampInt(body.utcOffsetMinutes, -840, 840, DEFAULT_SETTINGS.utcOffsetMinutes);
    const quietHoursStart = clampInt(body.quietHoursStart, 0, 23, DEFAULT_SETTINGS.quietHoursStart);
    const quietHoursEnd = clampInt(body.quietHoursEnd, 0, 23, DEFAULT_SETTINGS.quietHoursEnd);
    const maxPerDay = clampInt(body.maxPerDay, 0, 5, DEFAULT_SETTINGS.maxPerDay);
    const reminderTypes = body.reminderTypes && typeof body.reminderTypes === 'object' ? body.reminderTypes : {};
    const remindTodayMissing = parseBoolean(reminderTypes.todayMissing, DEFAULT_SETTINGS.reminderTypes.todayMissing);
    const remindTomorrowMissing = parseBoolean(reminderTypes.tomorrowMissing, DEFAULT_SETTINGS.reminderTypes.tomorrowMissing);
    const remindMissYou = parseBoolean(reminderTypes.missYou, DEFAULT_SETTINGS.reminderTypes.missYou);
    const householdId = await resolveHouseholdId(database, userId, body.householdId);

    const now = new Date();

    await database
      .insert(notificationSettings)
      .values({
        userId,
        enabled,
        householdId,
        utcOffsetMinutes,
        quietHoursStart,
        quietHoursEnd,
        maxPerDay,
        remindTodayMissing,
        remindTomorrowMissing,
        remindMissYou,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: notificationSettings.userId,
        set: {
          enabled,
          householdId,
          utcOffsetMinutes,
          quietHoursStart,
          quietHoursEnd,
          maxPerDay,
          remindTodayMissing,
          remindTomorrowMissing,
          remindMissYou,
          lastSeenAt: now,
          updatedAt: now,
        },
      });

    if (!enabled) {
      await database
        .update(pushTokens)
        .set({ disabledAt: now, updatedAt: now })
        .where(eq(pushTokens.userId, userId));
    }

    const pushToken = normalizeExpoPushToken(body.pushToken);
    const deviceId = typeof body.deviceId === 'string' && body.deviceId.trim() ? body.deviceId.trim().slice(0, 128) : null;
    const platform = typeof body.platform === 'string' && body.platform.trim() ? body.platform.trim().slice(0, 32) : null;
    if (pushToken) {
      await database
        .insert(pushTokens)
        .values({
          id: randomUUID(),
          userId,
          token: pushToken,
          deviceId,
          platform,
          disabledAt: enabled ? null : now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pushTokens.token,
          set: {
            userId,
            deviceId,
            platform,
            disabledAt: enabled ? null : now,
            lastSeenAt: now,
            updatedAt: now,
          },
        });
    }

    const res = NextResponse.json({ ok: true }, { status: 200 });
    res.headers.set('x-request-id', requestId);
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    console.error('[NOTIFICATION_SETTINGS_PUT]', { requestId, error });
    const res = NextResponse.json({ error: 'internal_error', requestId }, { status: 500 });
    res.headers.set('x-request-id', requestId);
    res.headers.set('cache-control', 'no-store');
    return res;
  }
}
