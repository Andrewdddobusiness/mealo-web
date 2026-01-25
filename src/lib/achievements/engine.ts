import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from '@/db/schema';
import { userAchievements } from '@/db/schema';

import { ACHIEVEMENTS, type AchievementDefinition } from './definitions';

type Database = NeonHttpDatabase<typeof schema>;

export type AchievementStatus = AchievementDefinition & {
  progress: number;
  unlockedAt: string | null;
};

function parseCountRow(result: { rows?: unknown[] }): number {
  const row = (result.rows ?? [])[0] as { count?: unknown } | undefined;
  const raw = row?.count;
  const count = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(count) ? count : 0;
}

function clampProgress(progress: number, target: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return Math.min(Math.floor(progress), target);
}

function dateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysUtc(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function maxConsecutiveDateKeys(dateKeys: string[]): number {
  if (dateKeys.length === 0) return 0;
  const uniqueSorted = Array.from(new Set(dateKeys)).sort();
  let best = 1;
  let current = 1;

  for (let i = 1; i < uniqueSorted.length; i += 1) {
    const prevMs = Date.parse(`${uniqueSorted[i - 1]}T00:00:00Z`);
    const nextMs = Date.parse(`${uniqueSorted[i]}T00:00:00Z`);
    const diffDays = (nextMs - prevMs) / (24 * 60 * 60 * 1000);
    if (diffDays === 1) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 1;
    }
  }

  return best;
}

type ComputedSignals = {
  totalPlans: number;
  maxUpcomingDaysPlanned: number;
  maxUpcomingStreak: number;
  createdMeals: number;
  invitesCreated: number;
  aiScanUsed: number;
  aiTotalUsed: number;
};

async function computeSignals(database: Database, userId: string): Promise<ComputedSignals> {
  const householdRes = await database.execute(sql`
    SELECT household_id AS id
    FROM household_members
    WHERE user_id = ${userId}
  `);
  const householdIds = (householdRes.rows ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const now = new Date();
  const today = dateKeyUtc(now);
  const end = addDaysUtc(today, 6);

  const [
    mealsCountRes,
    inviteCountRes,
    aiScanRes,
    aiTotalRes,
    planAnyRes,
    planWindowRes,
  ] = await Promise.all([
    database.execute(sql`SELECT COUNT(*)::int AS count FROM meals WHERE created_by = ${userId}`),
    database.execute(sql`SELECT COUNT(*)::int AS count FROM invites WHERE created_by = ${userId}`),
    database.execute(
      sql`SELECT COALESCE(SUM(used), 0)::int AS count FROM ai_usage WHERE user_id = ${userId} AND feature = 'ai_scan_meal'`,
    ),
    database.execute(sql`SELECT COALESCE(SUM(used), 0)::int AS count FROM ai_usage WHERE user_id = ${userId}`),
    householdIds.length
      ? database.execute(sql`
          SELECT COUNT(*)::int AS count
          FROM plans
          WHERE household_id = ANY(${householdIds}::text[])
        `)
      : Promise.resolve({ rows: [{ count: 0 }] }),
    householdIds.length
      ? database.execute(sql`
          SELECT household_id AS household_id, date AS date_key
          FROM plans
          WHERE household_id = ANY(${householdIds}::text[])
            AND date >= ${today}
            AND date <= ${end}
        `)
      : Promise.resolve({ rows: [] }),
  ]);

  const plansInWindowByHousehold = new Map<string, Set<string>>();
  for (const raw of planWindowRes.rows ?? []) {
    const row = raw as { household_id?: unknown; date_key?: unknown };
    const householdId = typeof row.household_id === 'string' ? row.household_id : '';
    const dateKey = typeof row.date_key === 'string' ? row.date_key : '';
    if (!householdId || !dateKey) continue;
    const set = plansInWindowByHousehold.get(householdId) ?? new Set<string>();
    set.add(dateKey);
    plansInWindowByHousehold.set(householdId, set);
  }

  let maxUpcomingDaysPlanned = 0;
  let maxUpcomingStreak = 0;
  for (const set of plansInWindowByHousehold.values()) {
    const dates = Array.from(set);
    maxUpcomingDaysPlanned = Math.max(maxUpcomingDaysPlanned, dates.length);
    maxUpcomingStreak = Math.max(maxUpcomingStreak, maxConsecutiveDateKeys(dates));
  }

  return {
    totalPlans: parseCountRow(planAnyRes),
    maxUpcomingDaysPlanned,
    maxUpcomingStreak,
    createdMeals: parseCountRow(mealsCountRes),
    invitesCreated: parseCountRow(inviteCountRes),
    aiScanUsed: parseCountRow(aiScanRes),
    aiTotalUsed: parseCountRow(aiTotalRes),
  };
}

function buildAchievementStatuses(signals: ComputedSignals): Array<Pick<AchievementStatus, 'id' | 'progress'>> {
  const planFirst = signals.totalPlans > 0 ? 1 : 0;

  return [
    { id: 'plan_first', progress: planFirst },
    { id: 'plan_streak_3', progress: signals.maxUpcomingStreak },
    { id: 'plan_week', progress: signals.maxUpcomingStreak },
    { id: 'household_hero', progress: signals.maxUpcomingDaysPlanned },
    { id: 'meal_first', progress: signals.createdMeals },
    { id: 'meal_chef_10', progress: signals.createdMeals },
    { id: 'invite_first', progress: signals.invitesCreated },
    { id: 'ai_first_scan', progress: signals.aiScanUsed },
    { id: 'ai_power_user_20', progress: signals.aiTotalUsed },
  ];
}

export async function syncUserAchievements(database: Database, userId: string): Promise<{
  achievements: AchievementStatus[];
  unlocked: AchievementStatus[];
}> {
  const [existingRows, signals] = await Promise.all([
    database
      .select({
        id: userAchievements.id,
        achievementId: userAchievements.achievementId,
        progress: userAchievements.progress,
        unlockedAt: userAchievements.unlockedAt,
      })
      .from(userAchievements)
      .where(eq(userAchievements.userId, userId)),
    computeSignals(database, userId),
  ]);

  const existingById = new Map<
    string,
    { id: string; progress: number; unlockedAt: Date | null }
  >();
  for (const row of existingRows) {
    existingById.set(row.achievementId, {
      id: row.id,
      progress: typeof row.progress === 'number' ? row.progress : 0,
      unlockedAt: row.unlockedAt instanceof Date ? row.unlockedAt : null,
    });
  }

  const computed = buildAchievementStatuses(signals);
  const now = new Date();

  const unlocked: AchievementStatus[] = [];
  const upserts = ACHIEVEMENTS.map((def) => {
    const computedRow = computed.find((c) => c.id === def.id);
    const rawProgress = computedRow ? computedRow.progress : 0;
    const progress = clampProgress(rawProgress, def.target);

    const existing = existingById.get(def.id) ?? null;
    const alreadyUnlocked = Boolean(existing?.unlockedAt);
    const isUnlocked = progress >= def.target;

    const unlockedAt = alreadyUnlocked
      ? existing!.unlockedAt!
      : isUnlocked
        ? now
        : null;

    const unlockedAtIso = unlockedAt ? unlockedAt.toISOString() : null;
    const status: AchievementStatus = {
      ...def,
      progress,
      unlockedAt: unlockedAtIso,
    };

    if (!alreadyUnlocked && isUnlocked) {
      unlocked.push(status);
    }

    return {
      id: existing?.id ?? randomUUID(),
      userId,
      achievementId: def.id,
      progress,
      unlockedAt,
      meta: null,
      createdAt: now,
      updatedAt: now,
    };
  });

  if (upserts.length > 0) {
    await database
      .insert(userAchievements)
      .values(upserts)
      .onConflictDoUpdate({
        target: [userAchievements.userId, userAchievements.achievementId],
        set: {
          progress: sql`excluded.progress`,
          unlockedAt: sql`COALESCE(${userAchievements.unlockedAt}, excluded.unlocked_at)`,
          updatedAt: now,
        },
      });
  }

  const achievements: AchievementStatus[] = ACHIEVEMENTS.map((def) => {
    const computedRow = upserts.find((u) => u.achievementId === def.id);
    const unlockedAtIso = computedRow?.unlockedAt ? computedRow.unlockedAt.toISOString() : null;
    return {
      ...def,
      progress: typeof computedRow?.progress === 'number' ? computedRow.progress : 0,
      unlockedAt: unlockedAtIso,
    };
  });

  return { achievements, unlocked };
}

