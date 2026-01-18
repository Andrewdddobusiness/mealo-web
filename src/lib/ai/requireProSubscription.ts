import { eq } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from '@/db/schema';
import { subscriptions, users } from '@/db/schema';

export type AiFeature = 'ai_generate_meal' | 'ai_scan_meal' | 'ai_import_video_meal';

type DbClient = NeonHttpDatabase<typeof schema>;

export class SubscriptionRequiredError extends Error {
  readonly name = 'SubscriptionRequiredError';
  readonly code = 'subscription_required';
  readonly status = 402;
  readonly feature: AiFeature;

  constructor(feature: AiFeature) {
    super('Subscription required');
    this.feature = feature;
  }
}

export async function requireProSubscriptionForAi(db: DbClient, userId: string, feature: AiFeature): Promise<void> {
  const [userRow, sub] = await Promise.all([
    db
      .select({ proOverride: users.proOverride })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  if (userRow?.proOverride) return;

  const now = new Date();
  const expiresAt = sub?.expiresAt instanceof Date ? sub.expiresAt : null;
  const isActive = Boolean(sub?.isActive) && Boolean(expiresAt && expiresAt > now);
  if (!isActive) throw new SubscriptionRequiredError(feature);
}
