import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '@/db';
import {
  AiConfigError,
  AiProviderError,
  AiTimeoutError,
  AiValidationError,
} from '@/lib/ai/generateMeal';
import { importMealFromVideo, validateImportVideoMealInput } from '@/lib/ai/importVideoMeal';
import { requireProSubscriptionForAi, SubscriptionRequiredError } from '@/lib/ai/requireProSubscription';
import { AiUsageLimitError, consumeAiUsage } from '@/lib/ai/aiUsage';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 6;
const rateLimitByUser = new Map<string, { resetAtMs: number; count: number }>();

function jsonError(
  status: number,
  error: string,
  message: string,
  requestId: string,
  meta?: Record<string, unknown>,
) {
  const res = NextResponse.json({ error, message, requestId, ...meta }, { status });
  res.headers.set('x-request-id', requestId);
  res.headers.set('cache-control', 'no-store');
  return res;
}

export async function POST(req: Request) {
  const requestId = randomUUID();

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return jsonError(401, 'unauthorized', 'You must be signed in to import a meal.', requestId);
    }

    if (!db) {
      return jsonError(500, 'server_misconfigured', 'Database is not configured.', requestId);
    }

    await requireProSubscriptionForAi(db, userId, 'ai_import_video_meal');

    const nowMs = Date.now();
    const existing = rateLimitByUser.get(userId);
    if (!existing || existing.resetAtMs <= nowMs) {
      rateLimitByUser.set(userId, { resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS, count: 1 });
    } else if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
      const res = jsonError(
        429,
        'rate_limited',
        `Too many requests. Try again in ${retryAfterSeconds}s.`,
        requestId,
      );
      res.headers.set('retry-after', String(retryAfterSeconds));
      return res;
    } else {
      existing.count += 1;
      rateLimitByUser.set(userId, existing);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return jsonError(400, 'invalid_request', 'Invalid JSON body.', requestId);
    }

    let sanitizedInput: ReturnType<typeof validateImportVideoMealInput>;
    try {
      sanitizedInput = validateImportVideoMealInput(body as any);
    } catch (error) {
      if (error instanceof AiValidationError) {
        return jsonError(400, 'invalid_request', error.message, requestId);
      }
      throw error;
    }

    await consumeAiUsage(db, userId, 'ai_import_video_meal');

    const result = await importMealFromVideo(sanitizedInput);

    const res = NextResponse.json({ recipes: result.recipes, meta: result.meta }, { status: 200 });
    res.headers.set('x-request-id', requestId);
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    if (error instanceof AiTimeoutError) {
      return jsonError(504, 'ai_timeout', 'AI provider timed out. Please try again.', requestId);
    }

    if (error instanceof AiProviderError) {
      return jsonError(502, 'ai_provider_error', 'AI provider error. Please try again.', requestId);
    }

    if (error instanceof AiValidationError) {
      // Validation errors here are typically URL issues or inaccessible videos.
      return jsonError(400, 'invalid_request', error.message, requestId);
    }

    if (error instanceof AiConfigError) {
      console.error('[AI_IMPORT_VIDEO_CONFIG]', { requestId, error });
      return jsonError(500, 'server_misconfigured', 'AI provider is not configured.', requestId);
    }

    if (error instanceof SubscriptionRequiredError) {
      return jsonError(error.status, error.code, 'Upgrade to Pro to import meals from videos.', requestId, {
        feature: error.feature,
      });
    }

    if (error instanceof AiUsageLimitError) {
      const retryAfterSeconds = Math.max(1, Math.ceil((error.period.endsAt.getTime() - Date.now()) / 1000));
      const res = jsonError(
        error.status,
        error.code,
        `Monthly AI limit reached. Try again after ${error.period.endsAt.toISOString()}.`,
        requestId,
        {
          feature: error.feature,
          period: error.period.key,
          limit: error.limit,
          used: error.used,
          resetsAt: error.period.endsAt.toISOString(),
        },
      );
      res.headers.set('retry-after', String(retryAfterSeconds));
      return res;
    }

    console.error('[AI_IMPORT_VIDEO]', { requestId, error });
    return jsonError(500, 'internal_error', 'Something went wrong importing your meal.', requestId);
  }
}
