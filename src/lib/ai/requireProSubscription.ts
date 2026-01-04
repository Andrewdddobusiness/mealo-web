import { eq } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from '@/db/schema';
import { subscriptions } from '@/db/schema';

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
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
  if (!sub?.isActive) throw new SubscriptionRequiredError(feature);
}
