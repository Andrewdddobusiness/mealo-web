const RATE_LIMIT_WINDOW_MS = 25_000;
const MAX_TRACKED_USERS = 2_000;

const lastRecomputeByUser = new Map<string, number>();

function pruneOldEntries(nowMs: number): void {
  if (lastRecomputeByUser.size <= MAX_TRACKED_USERS) return;
  const cutoffMs = nowMs - RATE_LIMIT_WINDOW_MS * 2;
  for (const [key, value] of lastRecomputeByUser.entries()) {
    if (value <= cutoffMs) {
      lastRecomputeByUser.delete(key);
    }
  }

  while (lastRecomputeByUser.size > MAX_TRACKED_USERS) {
    const oldestKey = lastRecomputeByUser.keys().next().value as string | undefined;
    if (!oldestKey) break;
    lastRecomputeByUser.delete(oldestKey);
  }
}

export function canRecomputeNutritionForUser(userId: string, nowMs: number = Date.now()): boolean {
  const prevMs = lastRecomputeByUser.get(userId) ?? 0;
  if (nowMs - prevMs < RATE_LIMIT_WINDOW_MS) return false;
  lastRecomputeByUser.set(userId, nowMs);
  pruneOldEntries(nowMs);
  return true;
}

export function clearNutritionRecomputeRateLimitForTests(): void {
  lastRecomputeByUser.clear();
}
