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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  const code = error.code;
  return typeof code === 'string' ? code : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function isUndefinedTableError(error: unknown, tableName?: string): boolean {
  const code = getErrorCode(error);
  if (code === '42P01') return true;
  const msg = getErrorMessage(error).toLowerCase();
  if (!msg.includes('does not exist')) return false;
  if (!tableName) return true;
  return msg.includes(tableName.toLowerCase());
}

function isUndefinedColumnError(error: unknown, tableOrColumnHint?: string): boolean {
  const code = getErrorCode(error);
  if (code === '42703') return true;
  const msg = getErrorMessage(error).toLowerCase();
  if (!msg.includes('column') || !msg.includes('does not exist')) return false;
  if (!tableOrColumnHint) return true;
  return msg.includes(tableOrColumnHint.toLowerCase());
}

function isSchemaMissingError(error: unknown, hint?: string): boolean {
  return isUndefinedTableError(error, hint) || isUndefinedColumnError(error, hint);
}

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

async function safeExecute(
  database: Database,
  query: Parameters<Database['execute']>[0],
  fallback: { rows: unknown[] },
  tableName: string,
): Promise<{ rows: unknown[] }> {
  try {
    return await database.execute(query);
  } catch (error) {
    if (isSchemaMissingError(error, tableName)) {
      console.warn('[ACHIEVEMENTS] schema mismatch; using fallback', { tableName, error: getErrorMessage(error) });
      return fallback;
    }
    throw error;
  }
}

async function computeSignals(database: Database, userId: string): Promise<ComputedSignals> {
  const householdRes = await safeExecute(
    database,
    sql`
      SELECT household_id AS id
      FROM household_members
      WHERE user_id = ${userId}
    `,
    { rows: [] },
    'household_members',
  );
  const householdIds = (householdRes.rows ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const householdIdList = householdIds.length
    ? sql.join(
        householdIds.map((id) => sql`${id}`),
        sql`, `,
      )
    : sql``;

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
    safeExecute(
      database,
      sql`SELECT COUNT(*)::int AS count FROM meals WHERE created_by = ${userId}`,
      { rows: [{ count: 0 }] },
      'meals',
    ),
    safeExecute(
      database,
      sql`SELECT COUNT(*)::int AS count FROM invites WHERE created_by = ${userId}`,
      { rows: [{ count: 0 }] },
      'invites',
    ),
    safeExecute(
      database,
      sql`SELECT COALESCE(SUM(used), 0)::int AS count FROM ai_usage WHERE user_id = ${userId} AND feature = 'ai_scan_meal'`,
      { rows: [{ count: 0 }] },
      'ai_usage',
    ),
    safeExecute(
      database,
      sql`SELECT COALESCE(SUM(used), 0)::int AS count FROM ai_usage WHERE user_id = ${userId}`,
      { rows: [{ count: 0 }] },
      'ai_usage',
    ),
    householdIds.length
      ? safeExecute(
          database,
          sql`
            SELECT COUNT(*)::int AS count
            FROM plans
            WHERE household_id IN (${householdIdList})
          `,
          { rows: [{ count: 0 }] },
          'plans',
        )
      : Promise.resolve({ rows: [{ count: 0 }] }),
    householdIds.length
      ? safeExecute(
          database,
          sql`
            SELECT household_id AS household_id, date AS date_key
            FROM plans
            WHERE household_id IN (${householdIdList})
              AND date >= ${today}
              AND date <= ${end}
          `,
          { rows: [] },
          'plans',
        )
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
    { id: 'plan_streak_5', progress: signals.maxUpcomingStreak },
    { id: 'plan_week', progress: signals.maxUpcomingStreak },
    { id: 'plan_total_10', progress: signals.totalPlans },
    { id: 'plan_total_25', progress: signals.totalPlans },
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
  const signals = await computeSignals(database, userId);

  let hasUserAchievementsTable = true;
  const existingRows = await database
    .select({
      id: userAchievements.id,
      achievementId: userAchievements.achievementId,
      progress: userAchievements.progress,
      unlockedAt: userAchievements.unlockedAt,
    })
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId))
    .catch((error) => {
      if (isSchemaMissingError(error, 'user_achievements')) {
        hasUserAchievementsTable = false;
        console.warn('[ACHIEVEMENTS] user_achievements unavailable; returning computed statuses only', {
          userId,
          error: getErrorMessage(error),
        });
        return [] as Array<{
          id: string;
          achievementId: string;
          progress: number;
          unlockedAt: Date | null;
        }>;
      }
      throw error;
    });

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
  const unlockFallbackIso = `${dateKeyUtc(now)}T00:00:00.000Z`;
  const storageAvailable = hasUserAchievementsTable;

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
        ? (storageAvailable ? now : new Date(unlockFallbackIso))
        : null;

    const unlockedAtIso = unlockedAt ? unlockedAt.toISOString() : null;
    const status: AchievementStatus = {
      ...def,
      progress,
      unlockedAt: unlockedAtIso,
    };

    if (storageAvailable && !alreadyUnlocked && isUnlocked) {
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

  if (storageAvailable && upserts.length > 0) {
    try {
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
    } catch (error) {
      if (isSchemaMissingError(error, 'user_achievements')) {
        console.warn('[ACHIEVEMENTS] failed to persist achievements; continuing without storage', {
          userId,
          error: getErrorMessage(error),
        });
      } else {
        throw error;
      }
    }
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
