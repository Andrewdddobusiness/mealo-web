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
import { scanMealFromImage } from '@/lib/ai/scanMeal';
import { requireProSubscriptionForAi, SubscriptionRequiredError } from '@/lib/ai/requireProSubscription';
import { AiUsageLimitError, consumeAiUsage } from '@/lib/ai/aiUsage';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 6;
const rateLimitByUser = new Map<string, { resetAtMs: number; count: number }>();

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

function jsonError(status: number, error: string, message: string, requestId: string, meta?: Record<string, unknown>) {
  const res = NextResponse.json({ error, message, requestId, ...meta }, { status });
  res.headers.set('x-request-id', requestId);
  res.headers.set('cache-control', 'no-store');
  return res;
}

function parseMaxIngredients(formData: FormData): number | undefined {
  const raw = formData.get('maxIngredients');
  if (typeof raw !== 'string') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function POST(req: Request) {
  const requestId = randomUUID();

  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return jsonError(401, 'unauthorized', 'You must be signed in to scan a meal.', requestId);
    }

    if (!db) {
      return jsonError(500, 'server_misconfigured', 'Database is not configured.', requestId);
    }

    await requireProSubscriptionForAi(db, userId, 'ai_scan_meal');

    const nowMs = Date.now();
    const existing = rateLimitByUser.get(userId);
    if (!existing || existing.resetAtMs <= nowMs) {
      rateLimitByUser.set(userId, { resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS, count: 1 });
    } else if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
      const res = jsonError(429, 'rate_limited', `Too many requests. Try again in ${retryAfterSeconds}s.`, requestId);
      res.headers.set('retry-after', String(retryAfterSeconds));
      return res;
    } else {
      existing.count += 1;
      rateLimitByUser.set(userId, existing);
    }

    const formData = await req.formData().catch(() => null);
    if (!formData) {
      return jsonError(400, 'invalid_request', 'Expected multipart form data.', requestId);
    }

    const image = formData.get('image');
    if (!image || typeof image !== 'object' || typeof (image as any).arrayBuffer !== 'function') {
      return jsonError(400, 'invalid_request', 'Missing required field: image.', requestId);
    }

    const file = image as File;
    if (typeof file.size === 'number' && file.size > MAX_IMAGE_BYTES) {
      return jsonError(413, 'payload_too_large', 'Image is too large. Please try a smaller photo.', requestId);
    }

    const mimeType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
    const normalizedType = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
    if (!normalizedType || !ALLOWED_IMAGE_TYPES.has(normalizedType)) {
      return jsonError(415, 'unsupported_media_type', 'Unsupported image type. Use JPG or PNG.', requestId);
    }

    const maxIngredients = parseMaxIngredients(formData);

    await consumeAiUsage(db, userId, 'ai_scan_meal');

    const bytes = Buffer.from(await file.arrayBuffer());
    const imageBase64 = bytes.toString('base64');

    const generated = await scanMealFromImage({
      imageBase64,
      mimeType: normalizedType,
      maxIngredients,
    });

    const res = NextResponse.json({ meal: generated }, { status: 200 });
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
      return jsonError(502, 'invalid_ai_response', error.message, requestId);
    }

    if (error instanceof AiConfigError) {
      console.error('[AI_SCAN_MEAL_CONFIG]', { requestId, error });
      return jsonError(500, 'server_misconfigured', 'AI provider is not configured.', requestId);
    }

    if (error instanceof SubscriptionRequiredError) {
      return jsonError(error.status, error.code, 'Upgrade to Pro to scan meals with AI.', requestId, {
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

    console.error('[AI_SCAN_MEAL]', { requestId, error });
    return jsonError(500, 'internal_error', 'Something went wrong scanning your meal.', requestId);
  }
}
