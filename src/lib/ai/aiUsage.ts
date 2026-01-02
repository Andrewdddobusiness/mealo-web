import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from '@/db/schema';
import type { AiFeature } from '@/lib/ai/requireProSubscription';

type DbClient = NeonHttpDatabase<typeof schema>;

export type AiUsagePeriod = {
  key: string; // YYYY-MM
  startsAt: Date;
  endsAt: Date;
};

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

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getCurrentAiUsagePeriod(now: Date = new Date()): AiUsagePeriod {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth(); // 0-11
  const startsAt = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const endsAt = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
  const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  return { key, startsAt, endsAt };
}

export function getMonthlyAiLimit(feature: AiFeature): number {
  if (feature === 'ai_scan_meal') {
    return parseNonNegativeInt(process.env.AI_SCAN_MEAL_MONTHLY_LIMIT, 30);
  }
  return parseNonNegativeInt(process.env.AI_GENERATE_MEAL_MONTHLY_LIMIT, 60);
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
  const period = getCurrentAiUsagePeriod(opts?.now);
  const limit = getMonthlyAiLimit(feature);

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

export async function getAiUsageForPeriod(
  db: DbClient,
  userId: string,
  period: AiUsagePeriod,
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

  const scanLimit = getMonthlyAiLimit('ai_scan_meal');
  const generateLimit = getMonthlyAiLimit('ai_generate_meal');

  const scanUsed = usageByFeature.get('ai_scan_meal') ?? 0;
  const generateUsed = usageByFeature.get('ai_generate_meal') ?? 0;

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
  };
}

