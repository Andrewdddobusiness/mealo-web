import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from '@/db/schema';
import { households, notificationSettings, notificationSends, plans, pushTokens } from '@/db/schema';

type ReminderType = 'plan_gap_today' | 'plan_gap_tomorrow' | 'miss_you';

type CopyVariant = { title: string; body: string };

const COPY: Record<ReminderType, CopyVariant[]> = {
  plan_gap_today: [
    { title: "What's for dinner?", body: "No meal planned for today. Add one in Mealo." },
    { title: "Quick dinner plan?", body: "Nothing planned for today yet — want to add a meal?" },
    { title: 'Plan today in 30 seconds', body: 'Pick one meal for today and keep the streak going.' },
    { title: 'Dinner plan check', body: 'Take a sec to plan today’s meal.' },
    { title: 'Future-you will thank you', body: 'Add today’s meal now — less stress later.' },
    { title: 'One meal away', body: 'Add something for today and you’re set.' },
  ],
  plan_gap_tomorrow: [
    { title: 'Tomorrow’s looking empty', body: 'Want to plan a meal for tomorrow?' },
    { title: 'Quick plan for tomorrow?', body: 'Add one meal now so future-you can relax.' },
    { title: 'One tap to stay on track', body: 'Plan tomorrow’s meal in Mealo.' },
    { title: 'Tomorrow’s meal?', body: 'Choose one meal for tomorrow in Mealo.' },
    { title: 'Plan ahead', body: 'A quick plan for tomorrow can save the scramble.' },
    { title: 'Keep the momentum', body: 'Add a meal for tomorrow and stay on track.' },
  ],
  miss_you: [
    { title: 'We miss you', body: 'Plan one meal to get back on track.' },
    { title: 'Your planner misses you', body: 'Add one meal and make tomorrow easier.' },
    { title: 'Tiny nudge', body: 'Open Mealo and plan your next meal.' },
    { title: 'Come back to your planner', body: 'Plan one meal and you’re back in the groove.' },
    { title: 'Just checking in', body: 'Open Mealo and plan your next meal.' },
    { title: 'A little nudge', body: 'Want to plan something this week?' },
  ],
};

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseAllowlist(value: string | undefined): Set<string> | null {
  if (!value) return null;
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? new Set(parts) : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function localNowFromUtcOffset(now: Date, utcOffsetMinutes: number): Date {
  // Convert "now" into a pseudo-UTC Date representing the user's local time.
  return new Date(now.getTime() - utcOffsetMinutes * 60_000);
}

function localDayKey(localNow: Date): string {
  const y = localNow.getUTCFullYear();
  const m = localNow.getUTCMonth() + 1;
  const d = localNow.getUTCDate();
  const mm = m < 10 ? `0${m}` : String(m);
  const dd = d < 10 ? `0${d}` : String(d);
  return `${y}-${mm}-${dd}`;
}

function dateKeyForLocalDate(localNow: Date, utcOffsetMinutes: number, dayDelta: number): string {
  const baseUtc = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + dayDelta, 0, 0, 0, 0);
  const utcAtLocalMidnight = baseUtc + utcOffsetMinutes * 60_000;
  return new Date(utcAtLocalMidnight).toISOString().slice(0, 10);
}

function isWithinQuietHours(hour: number, start: number, end: number): boolean {
  const s = clampInt(start, 0, 23, 22);
  const e = clampInt(end, 0, 23, 8);
  if (s === e) return false;
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function pickVariant(type: ReminderType, seed: string): CopyVariant {
  const list = COPY[type] ?? COPY.plan_gap_today;
  const idx = list.length > 0 ? hashString(`${type}:${seed}`) % list.length : 0;
  return list[idx] ?? list[0] ?? { title: 'Mealo', body: 'Open Mealo.' };
}

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
};

type ExpoPushTicket = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

type ExpoPushResponse = { data?: ExpoPushTicket[] };

async function sendExpoPush(messages: ExpoPushMessage[]): Promise<Array<{ token: string; ok: boolean; error?: string }>> {
  if (messages.length === 0) return [];

  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(messages),
  });

  const json = (await res.json().catch(() => null)) as ExpoPushResponse | null;
  const data: ExpoPushTicket[] = Array.isArray(json?.data) ? json.data : [];
  const out: Array<{ token: string; ok: boolean; error?: string }> = [];

  for (let i = 0; i < messages.length; i += 1) {
    const token = messages[i]?.to;
    const item = data[i] ?? {};
    const status = typeof item.status === 'string' ? item.status : '';
    const ok = status === 'ok';
    const error =
      typeof item.details?.error === 'string'
        ? item.details.error
        : typeof item.message === 'string'
          ? item.message
          : undefined;
    out.push({ token, ok, ...(error ? { error } : null) });
  }

  return out;
}

type Database = NeonHttpDatabase<typeof schema>;

async function hasAnyPlanForDate(database: Database, householdId: string, dateKey: string): Promise<boolean> {
  const rows = await database
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.householdId, householdId), eq(plans.date, dateKey)))
    .limit(1);
  return rows.length > 0;
}

async function getUserSendCountForDay(database: Database, userId: string, dayKey: string): Promise<number> {
  const result = await database.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM notification_sends
    WHERE user_id = ${userId}
      AND day_key = ${dayKey}
  `);
  const row = (result.rows ?? [])[0] as { count?: unknown } | undefined;
  const count = typeof row?.count === 'number' ? row.count : typeof row?.count === 'string' ? Number.parseInt(row.count, 10) : 0;
  return Number.isFinite(count) ? count : 0;
}

export async function runNotificationReminderSweep(database: Database): Promise<{
  ok: boolean;
  evaluatedUsers: number;
  sentUsers: number;
  sentMessages: number;
  skipped: { disabled: number; quietHours: number; capped: number; missingToken: number; missingHousehold: number };
}> {
  if (parseBooleanEnv(process.env.NOTIFICATIONS_DISABLED)) {
    return {
      ok: true,
      evaluatedUsers: 0,
      sentUsers: 0,
      sentMessages: 0,
      skipped: { disabled: 0, quietHours: 0, capped: 0, missingToken: 0, missingHousehold: 0 },
    };
  }

  const allowlist = parseAllowlist(process.env.NOTIFICATIONS_ALLOWLIST_USER_IDS);
  const now = new Date();

  const rows = await database
    .select({
      userId: notificationSettings.userId,
      enabled: notificationSettings.enabled,
      householdId: notificationSettings.householdId,
      utcOffsetMinutes: notificationSettings.utcOffsetMinutes,
      quietHoursStart: notificationSettings.quietHoursStart,
      quietHoursEnd: notificationSettings.quietHoursEnd,
      maxPerDay: notificationSettings.maxPerDay,
      remindTodayMissing: notificationSettings.remindTodayMissing,
      remindTomorrowMissing: notificationSettings.remindTomorrowMissing,
      remindMissYou: notificationSettings.remindMissYou,
      lastSeenAt: notificationSettings.lastSeenAt,
      pushTokenId: pushTokens.id,
      pushToken: pushTokens.token,
      pushTokenDisabledAt: pushTokens.disabledAt,
      householdName: households.name,
    })
    .from(notificationSettings)
    .leftJoin(pushTokens, eq(notificationSettings.userId, pushTokens.userId))
    .leftJoin(households, eq(notificationSettings.householdId, households.id))
    .where(eq(notificationSettings.enabled, true));

  const byUser = new Map<
    string,
    {
      userId: string;
      householdId: string | null;
      householdName: string | null;
      utcOffsetMinutes: number;
      quietHoursStart: number;
      quietHoursEnd: number;
      maxPerDay: number;
      remindTodayMissing: boolean;
      remindTomorrowMissing: boolean;
      remindMissYou: boolean;
      lastSeenAt: Date | null;
      tokens: Array<{ id: string; token: string }>;
    }
  >();

  for (const row of rows) {
    const userId = row.userId;
    if (!userId) continue;
    if (allowlist && !allowlist.has(userId)) continue;
    const existing = byUser.get(userId);
    const token = typeof row.pushToken === 'string' ? row.pushToken.trim() : '';
    const tokenId = typeof row.pushTokenId === 'string' ? row.pushTokenId.trim() : '';
    const tokenDisabled = row.pushTokenDisabledAt instanceof Date;
    const tokenOk = Boolean(token && tokenId && !tokenDisabled);

    if (existing) {
      if (tokenOk) existing.tokens.push({ id: tokenId, token });
      continue;
    }

    const utcOffsetMinutes = clampInt(row.utcOffsetMinutes, -840, 840, 0);
    const quietHoursStart = clampInt(row.quietHoursStart, 0, 23, 22);
    const quietHoursEnd = clampInt(row.quietHoursEnd, 0, 23, 8);
    const maxPerDay = clampInt(row.maxPerDay, 0, 5, 1);

    byUser.set(userId, {
      userId,
      householdId: row.householdId ?? null,
      householdName: typeof row.householdName === 'string' ? row.householdName : null,
      utcOffsetMinutes,
      quietHoursStart,
      quietHoursEnd,
      maxPerDay,
      remindTodayMissing: Boolean(row.remindTodayMissing),
      remindTomorrowMissing: Boolean(row.remindTomorrowMissing),
      remindMissYou: Boolean(row.remindMissYou),
      lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt : null,
      tokens: tokenOk ? [{ id: tokenId, token }] : [],
    });
  }

  let evaluatedUsers = 0;
  let sentUsers = 0;
  let sentMessages = 0;
  const skipped = { disabled: 0, quietHours: 0, capped: 0, missingToken: 0, missingHousehold: 0 };

  for (const user of byUser.values()) {
    evaluatedUsers += 1;
    if (!user.householdId) {
      skipped.missingHousehold += 1;
      continue;
    }
    if (user.tokens.length === 0) {
      skipped.missingToken += 1;
      continue;
    }
    if (user.maxPerDay <= 0) {
      skipped.disabled += 1;
      continue;
    }

    const localNow = localNowFromUtcOffset(now, user.utcOffsetMinutes);
    const hour = localNow.getUTCHours();
    if (isWithinQuietHours(hour, user.quietHoursStart, user.quietHoursEnd)) {
      skipped.quietHours += 1;
      continue;
    }

    const dayKey = localDayKey(localNow);
    const alreadySentCount = await getUserSendCountForDay(database, user.userId, dayKey);
    if (alreadySentCount >= user.maxPerDay) {
      skipped.capped += 1;
      continue;
    }

    const todayDateKey = dateKeyForLocalDate(localNow, user.utcOffsetMinutes, 0);
    const tomorrowDateKey = dateKeyForLocalDate(localNow, user.utcOffsetMinutes, 1);

    let typeToSend: ReminderType | null = null;
    let dateKeyToSend: string | null = null;

    if (user.remindTodayMissing && hour >= 8 && hour < 12) {
      const planned = await hasAnyPlanForDate(database, user.householdId, todayDateKey);
      if (!planned) {
        typeToSend = 'plan_gap_today';
        dateKeyToSend = todayDateKey;
      }
    }

    if (!typeToSend && user.remindTomorrowMissing && hour >= 18 && hour < 22) {
      const planned = await hasAnyPlanForDate(database, user.householdId, tomorrowDateKey);
      if (!planned) {
        typeToSend = 'plan_gap_tomorrow';
        dateKeyToSend = tomorrowDateKey;
      }
    }

    if (!typeToSend && user.remindMissYou && hour >= 10 && hour < 20) {
      const lastSeenAt = user.lastSeenAt;
      if (lastSeenAt) {
        const daysSince = (now.getTime() - lastSeenAt.getTime()) / (24 * 60 * 60 * 1000);
        if (Number.isFinite(daysSince) && daysSince >= 3) {
          typeToSend = 'miss_you';
          dateKeyToSend = todayDateKey;
        }
      }
    }

    if (!typeToSend || !dateKeyToSend) continue;

    const copy = pickVariant(typeToSend, `${user.userId}:${dayKey}`);

    // Create a send record first (dedupe safety). If this conflicts, skip sending.
    const inserted = await database
      .insert(notificationSends)
      .values({
        id: randomUUID(),
        userId: user.userId,
        householdId: user.householdId,
        type: typeToSend,
        dayKey,
        dateKey: dateKeyToSend,
        meta: { title: copy.title, body: copy.body, hour, household: user.householdName ?? undefined },
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [notificationSends.userId, notificationSends.type, notificationSends.dayKey],
      })
      .returning({ id: notificationSends.id });

    if (inserted.length === 0) continue;

    const messages: ExpoPushMessage[] = user.tokens.map((t) => ({
      to: t.token,
      title: copy.title,
      body: copy.body,
      sound: 'default',
      priority: 'high',
      data: {
        screen: 'planner',
        dateKey: dateKeyToSend,
        householdId: user.householdId,
      },
    }));

    const sendResults = await sendExpoPush(messages);
    sentUsers += 1;
    sentMessages += messages.length;

    const invalidTokenIds: string[] = [];
    sendResults.forEach((r) => {
      if (r.ok) return;
      const error = (r.error ?? '').toLowerCase();
      const shouldDisable = error.includes('device') || error.includes('notregistered') || error.includes('invalid');
      if (!shouldDisable) return;
      const tokenId = user.tokens.find((t) => t.token === r.token)?.id;
      if (tokenId) invalidTokenIds.push(tokenId);
    });

    if (invalidTokenIds.length > 0) {
      await database.execute(sql`
        UPDATE push_tokens
        SET disabled_at = ${now}, updated_at = ${now}
        WHERE id = ANY(${invalidTokenIds}::text[])
      `);
    }
  }

  return { ok: true, evaluatedUsers, sentUsers, sentMessages, skipped };
}
