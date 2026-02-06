import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { recordIngredientUsage } from '@/lib/ingredients';
import { normalizeCuisine, normalizeIngredients, normalizeMealName } from '@/lib/normalizeMeal';
import {
  isBodyTooLarge,
  sanitizeStringArray,
  stripControlChars,
  validateMealName,
  validateShareToken,
  validateUuid,
} from '@/lib/validation';
import { getMealsColumnAvailability, insertMealCompat } from '@/db/compat';
import { autoRecomputeAndPersistMealNutrition } from '@/lib/nutrition/recomputeWorkflow';
import { db } from '@/db';
import { household_members, mealShareAcceptances, mealShares, meals } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_PER_USER = 20;
const rateLimitByUser = new Map<string, { resetAtMs: number; count: number }>();

const MAX_SOURCE_URL_LENGTH = 2048;
const MAX_INSTRUCTIONS = 60;

type ParsedSnapshot = {
  name: string;
  description: string | null;
  ingredients: Array<Record<string, unknown>>;
  instructions: string[];
  image: string | null;
  cuisine: string | null;
  sourceUrl: string | null;
};

function checkRateLimit(userId: string) {
  const nowMs = Date.now();
  const existing = rateLimitByUser.get(userId);
  if (!existing || existing.resetAtMs <= nowMs) {
    rateLimitByUser.set(userId, { resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS, count: 1 });
    return { allowed: true as const };
  }
  if (existing.count >= RATE_LIMIT_MAX_PER_USER) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
    return { allowed: false as const, retryAfterSeconds };
  }
  existing.count += 1;
  rateLimitByUser.set(userId, existing);
  return { allowed: true as const };
}

function sanitizeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = stripControlChars(value).trim();
  if (!trimmed) return null;
  const candidate = trimmed.length > MAX_SOURCE_URL_LENGTH ? trimmed.slice(0, MAX_SOURCE_URL_LENGTH) : trimmed;
  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return candidate;
  } catch {
    return null;
  }
}

function parseSnapshot(value: unknown): ParsedSnapshot | null {
  const snapshot = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

  const validatedName = validateMealName(snapshot.name);
  if (!validatedName) return null;

  const name = normalizeMealName(validatedName) ?? validatedName;
  const description =
    typeof snapshot.description === 'string' ? stripControlChars(snapshot.description).trim().slice(0, 280) || null : null;

  const normalizedIngredients = normalizeIngredients(snapshot.ingredients);
  const ingredients = Array.isArray(normalizedIngredients)
    ? (normalizedIngredients as Array<Record<string, unknown>>)
    : [];

  const instructions = sanitizeStringArray(snapshot.instructions, {
    maxItems: MAX_INSTRUCTIONS,
    maxItemLength: 400,
  });

  const image = typeof snapshot.image === 'string' ? stripControlChars(snapshot.image).trim().slice(0, 2048) || null : null;
  const cuisineRaw = typeof snapshot.cuisine === 'string' ? stripControlChars(snapshot.cuisine).trim().slice(0, 60) : '';
  const cuisine = cuisineRaw ? normalizeCuisine(cuisineRaw) ?? cuisineRaw : null;
  const sourceUrl = sanitizeSourceUrl(snapshot.sourceUrl);

  return {
    name,
    description,
    ingredients,
    instructions,
    image,
    cuisine,
    sourceUrl,
  };
}

async function resolveTargetHousehold(userId: string, requestedHouseholdId: string | null): Promise<string | null> {
  if (!db) return null;

  if (requestedHouseholdId) {
    const membershipRows = await db
      .select({ householdId: household_members.householdId })
      .from(household_members)
      .where(and(eq(household_members.householdId, requestedHouseholdId), eq(household_members.userId, userId)))
      .limit(1);
    return membershipRows[0]?.householdId ?? null;
  }

  const membershipRows = await db
    .select({ householdId: household_members.householdId })
    .from(household_members)
    .where(eq(household_members.userId, userId))
    .limit(1);

  return membershipRows[0]?.householdId ?? null;
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const limit = checkRateLimit(userId);
    if (!limit.allowed) {
      const res = new NextResponse('Too many requests. Please try again later.', { status: 429 });
      res.headers.set('retry-after', String(limit.retryAfterSeconds));
      return res;
    }

    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }

    if (isBodyTooLarge(req, 25_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const { token: tokenRaw } = await params;
    const token = validateShareToken(tokenRaw);
    if (!token) {
      return new NextResponse('Invalid token', { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const requestedHouseholdId = validateUuid(payload.householdId) ?? null;

    const shareRows = await db
      .select({
        id: mealShares.id,
        snapshot: mealShares.snapshot,
        expiresAt: mealShares.expiresAt,
        revokedAt: mealShares.revokedAt,
      })
      .from(mealShares)
      .where(eq(mealShares.token, token))
      .limit(1);

    if (shareRows.length === 0) {
      return new NextResponse('Recipe share not found', { status: 404 });
    }

    const share = shareRows[0];
    if (share.revokedAt) {
      return new NextResponse('Recipe share was revoked', { status: 410 });
    }
    if (share.expiresAt && new Date() > share.expiresAt) {
      return new NextResponse('Recipe share has expired', { status: 410 });
    }

    const existingAcceptanceRows = await db
      .select({
        id: mealShareAcceptances.id,
        createdMealId: mealShareAcceptances.createdMealId,
        householdId: mealShareAcceptances.householdId,
      })
      .from(mealShareAcceptances)
      .where(and(eq(mealShareAcceptances.shareId, share.id), eq(mealShareAcceptances.acceptedBy, userId)))
      .limit(1);

    if (existingAcceptanceRows.length > 0 && existingAcceptanceRows[0].createdMealId) {
      const existing = existingAcceptanceRows[0];
      const res = NextResponse.json({
        mealId: existing.createdMealId,
        householdId: existing.householdId,
        alreadyAccepted: true,
      });
      res.headers.set('cache-control', 'no-store');
      return res;
    }

    const targetHouseholdId = await resolveTargetHousehold(userId, requestedHouseholdId);
    if (!targetHouseholdId) {
      return new NextResponse('No available household to accept this recipe', { status: 400 });
    }

    const parsedSnapshot = parseSnapshot(share.snapshot);
    if (!parsedSnapshot) {
      return new NextResponse('Shared recipe payload is invalid', { status: 400 });
    }

    const mealId = uuidv4();
    const mealsColumns = await getMealsColumnAvailability(db);

    await insertMealCompat(db, {
      id: mealId,
      householdId: targetHouseholdId,
      name: parsedSnapshot.name,
      description: parsedSnapshot.description,
      ingredients: parsedSnapshot.ingredients,
      instructions: parsedSnapshot.instructions,
      image: parsedSnapshot.image,
      cuisine: parsedSnapshot.cuisine,
      sourceUrl: mealsColumns.sourceUrl ? parsedSnapshot.sourceUrl : undefined,
      createdBy: userId,
      isFavorite: false,
      rating: 0,
      createdAt: new Date(),
    });

    try {
      await recordIngredientUsage(db, userId, parsedSnapshot.ingredients);
    } catch (error) {
      console.error('[RECIPE_SHARE_ACCEPT_INGREDIENT_USAGE]', error);
    }

    await autoRecomputeAndPersistMealNutrition({
      db,
      mealId,
      mealName: parsedSnapshot.name,
      ingredients: parsedSnapshot.ingredients,
      loggerTag: 'RECIPE_SHARE_ACCEPT_NUTRITION',
    });

    const insertedAcceptances = await db
      .insert(mealShareAcceptances)
      .values({
        id: uuidv4(),
        shareId: share.id,
        acceptedBy: userId,
        createdMealId: mealId,
        householdId: targetHouseholdId,
        acceptedAt: new Date(),
      })
      .onConflictDoNothing({ target: [mealShareAcceptances.shareId, mealShareAcceptances.acceptedBy] })
      .returning({
        id: mealShareAcceptances.id,
        createdMealId: mealShareAcceptances.createdMealId,
        householdId: mealShareAcceptances.householdId,
      });

    if (insertedAcceptances.length === 0) {
      // Concurrent accept race: clean up duplicate meal and return the existing acceptance.
      await db.delete(meals).where(eq(meals.id, mealId)).catch(() => undefined);

      const acceptedRows = await db
        .select({
          createdMealId: mealShareAcceptances.createdMealId,
          householdId: mealShareAcceptances.householdId,
        })
        .from(mealShareAcceptances)
        .where(and(eq(mealShareAcceptances.shareId, share.id), eq(mealShareAcceptances.acceptedBy, userId)))
        .limit(1);

      const accepted = acceptedRows[0];
      if (!accepted?.createdMealId) {
        return new NextResponse('Could not resolve accepted recipe', { status: 409 });
      }

      const res = NextResponse.json({
        mealId: accepted.createdMealId,
        householdId: accepted.householdId,
        alreadyAccepted: true,
      });
      res.headers.set('cache-control', 'no-store');
      return res;
    }

    const res = NextResponse.json({
      mealId,
      householdId: targetHouseholdId,
      alreadyAccepted: false,
    });
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    console.error('[RECIPE_SHARE_ACCEPT_POST]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
