import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from '@/db/schema';
import type { AiFeature } from '@/lib/ai/requireProSubscription';
import { subscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';

type DbClient = NeonHttpDatabase<typeof schema>;

const AI_CREDITS_FEATURE = 'ai_credits';

export type AiUsagePeriod = {
  key: string; // YYYY-MM
  startsAt: Date;
  endsAt: Date;
};

export type AiUsageTier = 'free' | 'trial' | 'pro';

export class AiUsageLimitError extends Error {
  readonly name = 'AiUsageLimitError';
  readonly code = 'usage_limit_reached';
  readonly status = 429;
  readonly feature: AiFeature;
  readonly limit: number;
  readonly used: number;
  readonly period: AiUsagePeriod;

  constructor(input: { feature: AiFeature; limit: number; used: number; period: AiUsagePeriod }) {
    super('AI usage limit reached');
    this.feature = input.feature;
    this.limit = input.limit;
    this.used = input.used;
    this.period = input.period;
  }
}

export class AiCreditsLimitError extends Error {
  readonly name = 'AiCreditsLimitError';
  readonly code = 'ai_credits_limit_reached';
  readonly status = 429;
  readonly limit: number;
  readonly used: number;
  readonly period: AiUsagePeriod;

  constructor(input: { limit: number; used: number; period: AiUsagePeriod }) {
    super('AI credits limit reached');
    this.limit = input.limit;
    this.used = input.used;
    this.period = input.period;
  }
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseOptionalNonNegativeInt(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function getCurrentAiUsagePeriod(now: Date = new Date()): AiUsagePeriod {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth(); // 0-11
  const startsAt = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const endsAt = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  return { key, startsAt, endsAt };
}

function resolveSubscriptionTier(sub: typeof subscriptions.$inferSelect | undefined, now: Date): AiUsageTier {
  if (!sub) return 'free';
  const expiresAt = sub.expiresAt instanceof Date ? sub.expiresAt : new Date(sub.expiresAt as any);
  const isActive = Boolean(sub.isActive) && expiresAt > now;
  if (!isActive) return 'free';
  return sub.isTrial ? 'trial' : 'pro';
}

export function getAiUsagePeriodForSubscription(
  input: { subscription?: typeof subscriptions.$inferSelect; now?: Date },
): AiUsagePeriod {
  const now = input.now ?? new Date();
  const tier = resolveSubscriptionTier(input.subscription, now);
  if (tier === 'free') return getCurrentAiUsagePeriod(now);

  const sub = input.subscription;
  if (!sub) return getCurrentAiUsagePeriod(now);

  const startsAtRaw = sub.currentPeriodStart;
  const startsAt = startsAtRaw instanceof Date ? startsAtRaw : startsAtRaw ? new Date(startsAtRaw as any) : null;
  const endsAt = sub.expiresAt instanceof Date ? sub.expiresAt : new Date(sub.expiresAt as any);

  // If we don't have a reliable billing period start, fall back to calendar month.
  if (!startsAt || !(startsAt < endsAt)) return getCurrentAiUsagePeriod(now);

  // Keyed to billing period start so usage resets at trial→paid and each renewal.
  const key = `billing:${startsAt.getTime()}`;
  return { key, startsAt, endsAt };
}

export function getMonthlyAiLimit(feature: AiFeature): number {
  if (feature === 'ai_scan_meal') {
    return parseNonNegativeInt(process.env.AI_SCAN_MEAL_MONTHLY_LIMIT, 30);
  }
  if (feature === 'ai_import_video_meal') {
    return parseNonNegativeInt(process.env.AI_IMPORT_VIDEO_MEAL_MONTHLY_LIMIT, 20);
  }
  return parseNonNegativeInt(process.env.AI_GENERATE_MEAL_MONTHLY_LIMIT, 60);
}

export function getTrialAiLimit(feature: AiFeature): number {
  if (feature === 'ai_scan_meal') {
    return parseNonNegativeInt(process.env.AI_TRIAL_SCAN_MEAL_LIMIT, 10);
  }
  if (feature === 'ai_import_video_meal') {
    return parseNonNegativeInt(process.env.AI_TRIAL_IMPORT_VIDEO_MEAL_LIMIT, 0);
  }
  return parseNonNegativeInt(process.env.AI_TRIAL_GENERATE_MEAL_LIMIT, 5);
}

export function getAiLimitForTier(feature: AiFeature, tier: AiUsageTier): number {
  return tier === 'trial' ? getTrialAiLimit(feature) : getMonthlyAiLimit(feature);
}

export function getAiCreditCost(feature: AiFeature): number {
  if (feature === 'ai_scan_meal') {
    return parseNonNegativeInt(process.env.AI_SCAN_MEAL_CREDIT_COST, 2);
  }
  if (feature === 'ai_import_video_meal') {
    return parseNonNegativeInt(process.env.AI_IMPORT_VIDEO_MEAL_CREDIT_COST, 4);
  }
  return parseNonNegativeInt(process.env.AI_GENERATE_MEAL_CREDIT_COST, 1);
}

export function getMonthlyAiCreditsLimit(): number {
  const explicit = parseOptionalNonNegativeInt(process.env.AI_CREDITS_MONTHLY_LIMIT);
  if (explicit != null) return explicit;

  return (
    getMonthlyAiLimit('ai_generate_meal') * getAiCreditCost('ai_generate_meal') +
    getMonthlyAiLimit('ai_scan_meal') * getAiCreditCost('ai_scan_meal') +
    getMonthlyAiLimit('ai_import_video_meal') * getAiCreditCost('ai_import_video_meal')
  );
}

export function getAiCreditsLimitForTier(tier: AiUsageTier): number {
  if (tier !== 'trial') return getMonthlyAiCreditsLimit();
  return (
    getTrialAiLimit('ai_generate_meal') * getAiCreditCost('ai_generate_meal') +
    getTrialAiLimit('ai_scan_meal') * getAiCreditCost('ai_scan_meal') +
    getTrialAiLimit('ai_import_video_meal') * getAiCreditCost('ai_import_video_meal')
  );
}

function coerceUsed(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function consumeAiUsage(
  db: DbClient,
  userId: string,
  feature: AiFeature,
  opts?: { now?: Date },
): Promise<{ used: number; limit: number; period: AiUsagePeriod }> {
  const now = opts?.now ?? new Date();
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  const tier = resolveSubscriptionTier(subscription, now);
  const period = getAiUsagePeriodForSubscription({ subscription, now });
  const limit = getAiLimitForTier(feature, tier);

  if (limit <= 0) {
    throw new AiUsageLimitError({ feature, limit, used: 0, period });
  }

  const id = randomUUID();

  const result = await db.execute(sql`
    INSERT INTO ai_usage (id, user_id, feature, period, used, created_at, updated_at)
    VALUES (${id}, ${userId}, ${feature}, ${period.key}, 1, NOW(), NOW())
    ON CONFLICT (user_id, feature, period)
    DO UPDATE SET used = ai_usage.used + 1, updated_at = NOW()
    WHERE ai_usage.used < ${limit}
    RETURNING used;
  `);

  const updatedUsed = coerceUsed((result.rows?.[0] as any)?.used);
  if (updatedUsed != null) {
    return { used: updatedUsed, limit, period };
  }

  const existing = await db.execute(sql`
    SELECT used
    FROM ai_usage
    WHERE user_id = ${userId}
      AND feature = ${feature}
      AND period = ${period.key}
    LIMIT 1;
  `);

  const currentUsed = coerceUsed((existing.rows?.[0] as any)?.used) ?? limit;
  throw new AiUsageLimitError({ feature, limit, used: currentUsed, period });
}

export async function consumeAiCredits(
  db: DbClient,
  userId: string,
  feature: AiFeature,
  opts?: { now?: Date },
): Promise<{ used: number; limit: number; period: AiUsagePeriod }> {
  const now = opts?.now ?? new Date();
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  const tier = resolveSubscriptionTier(subscription, now);
  const period = getAiUsagePeriodForSubscription({ subscription, now });
  const limit = getAiCreditsLimitForTier(tier);
  const cost = getAiCreditCost(feature);

  if (cost <= 0) {
    return { used: 0, limit, period };
  }

  if (limit <= 0) {
    throw new AiCreditsLimitError({ limit, used: 0, period });
  }

  if (cost > limit) {
    throw new AiCreditsLimitError({ limit, used: 0, period });
  }

  const id = randomUUID();

  const result = await db.execute(sql`
    INSERT INTO ai_usage (id, user_id, feature, period, used, created_at, updated_at)
    VALUES (${id}, ${userId}, ${AI_CREDITS_FEATURE}, ${period.key}, ${cost}, NOW(), NOW())
    ON CONFLICT (user_id, feature, period)
    DO UPDATE SET used = ai_usage.used + ${cost}, updated_at = NOW()
    WHERE ai_usage.used + ${cost} <= ${limit}
    RETURNING used;
  `);

  const updatedUsed = coerceUsed((result.rows?.[0] as any)?.used);
  if (updatedUsed != null) {
    return { used: updatedUsed, limit, period };
  }

  const existing = await db.execute(sql`
    SELECT used
    FROM ai_usage
    WHERE user_id = ${userId}
      AND feature = ${AI_CREDITS_FEATURE}
      AND period = ${period.key}
    LIMIT 1;
  `);

  const currentUsed = coerceUsed((existing.rows?.[0] as any)?.used) ?? limit;
  throw new AiCreditsLimitError({ limit, used: currentUsed, period });
}

export async function getAiUsageForPeriod(
  db: DbClient,
  userId: string,
  period: AiUsagePeriod,
  opts?: { tier?: AiUsageTier },
): Promise<Record<AiFeature, { used: number; limit: number; remaining: number }>> {
  const rows = await db.execute(sql`
    SELECT feature, used
    FROM ai_usage
    WHERE user_id = ${userId}
      AND period = ${period.key};
  `);

  const usageByFeature = new Map<string, number>();
  for (const row of rows.rows ?? []) {
    const feature = typeof (row as any).feature === 'string' ? (row as any).feature : '';
    const used = coerceUsed((row as any).used) ?? 0;
    if (!feature) continue;
    usageByFeature.set(feature, used);
  }

  const tier = opts?.tier ?? 'pro';
  const scanLimit = getAiLimitForTier('ai_scan_meal', tier);
  const generateLimit = getAiLimitForTier('ai_generate_meal', tier);
  const importVideoLimit = getAiLimitForTier('ai_import_video_meal', tier);

  const scanUsed = usageByFeature.get('ai_scan_meal') ?? 0;
  const generateUsed = usageByFeature.get('ai_generate_meal') ?? 0;
  const importVideoUsed = usageByFeature.get('ai_import_video_meal') ?? 0;

  return {
    ai_scan_meal: {
      used: scanUsed,
      limit: scanLimit,
      remaining: Math.max(0, scanLimit - scanUsed),
    },
    ai_generate_meal: {
      used: generateUsed,
      limit: generateLimit,
      remaining: Math.max(0, generateLimit - generateUsed),
    },
    ai_import_video_meal: {
      used: importVideoUsed,
      limit: importVideoLimit,
      remaining: Math.max(0, importVideoLimit - importVideoUsed),
    },
  };
}

export async function getAiCreditsForPeriod(
  db: DbClient,
  userId: string,
  period: AiUsagePeriod,
  opts?: { tier?: AiUsageTier },
): Promise<{ used: number; limit: number; remaining: number }> {
  const limit = getAiCreditsLimitForTier(opts?.tier ?? 'pro');

  const row = await db.execute(sql`
    SELECT used
    FROM ai_usage
    WHERE user_id = ${userId}
      AND feature = ${AI_CREDITS_FEATURE}
      AND period = ${period.key}
    LIMIT 1;
  `);

  const used = coerceUsed((row.rows?.[0] as any)?.used) ?? 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
}
