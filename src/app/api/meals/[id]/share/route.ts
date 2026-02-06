import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { isBodyTooLarge, validateRecordId } from '@/lib/validation';
import { getMealsSelect } from '@/db/compat';
import { db } from '@/db';
import { globalMeals, household_members, mealShares, meals } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { addDays } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_PER_USER = 30;
const rateLimitByUser = new Map<string, { resetAtMs: number; count: number }>();

type ShareSnapshot = {
  name: string;
  description: string | null;
  ingredients: unknown[];
  instructions: unknown[];
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

function toSnapshot(payload: {
  name: unknown;
  description: unknown;
  ingredients: unknown;
  instructions: unknown;
  image: unknown;
  cuisine: unknown;
  sourceUrl?: unknown;
}): ShareSnapshot {
  return {
    name: typeof payload.name === 'string' ? payload.name.trim() : '',
    description: typeof payload.description === 'string' ? payload.description.trim() || null : null,
    ingredients: Array.isArray(payload.ingredients) ? payload.ingredients : [],
    instructions: Array.isArray(payload.instructions) ? payload.instructions : [],
    image: typeof payload.image === 'string' ? payload.image.trim() || null : null,
    cuisine: typeof payload.cuisine === 'string' ? payload.cuisine.trim() || null : null,
    sourceUrl: typeof payload.sourceUrl === 'string' ? payload.sourceUrl.trim() || null : null,
  };
}

function buildShareUrl(token: string): string {
  const base = (process.env.EXPO_PUBLIC_WEB_APP_URL || 'https://mealo.website').trim().replace(/\/+$/, '');
  return `${base}/recipe/${encodeURIComponent(token)}`;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

    if (isBodyTooLarge(req, 10_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const { id: idRaw } = await params;
    const mealId = validateRecordId(idRaw);
    if (!mealId) {
      return new NextResponse('Invalid meal id', { status: 400 });
    }

    const mealsSelect = await getMealsSelect(db);

    let sourceMealId: string | null = null;
    let sourceGlobalMealId: string | null = null;
    let sourceHouseholdId: string | null = null;
    let snapshot: ShareSnapshot | null = null;

    const householdMealRows = await db.select(mealsSelect).from(meals).where(eq(meals.id, mealId)).limit(1);
    if (householdMealRows.length > 0) {
      const sourceMeal = householdMealRows[0];
      const memberRows = await db
        .select({ id: household_members.id })
        .from(household_members)
        .where(and(eq(household_members.householdId, sourceMeal.householdId), eq(household_members.userId, userId)))
        .limit(1);

      if (memberRows.length === 0) {
        return new NextResponse('You are not allowed to share this recipe', { status: 403 });
      }

      sourceMealId = sourceMeal.id;
      sourceHouseholdId = sourceMeal.householdId;
      snapshot = toSnapshot({
        name: sourceMeal.name,
        description: sourceMeal.description,
        ingredients: sourceMeal.ingredients,
        instructions: sourceMeal.instructions,
        image: sourceMeal.image,
        cuisine: sourceMeal.cuisine,
        sourceUrl: sourceMeal.sourceUrl,
      });
    }

    if (!snapshot) {
      const globalRows = await db
        .select({
          id: globalMeals.id,
          name: globalMeals.name,
          description: globalMeals.description,
          ingredients: globalMeals.ingredients,
          instructions: globalMeals.instructions,
          image: globalMeals.image,
          cuisine: globalMeals.cuisine,
        })
        .from(globalMeals)
        .where(eq(globalMeals.id, mealId))
        .limit(1);

      if (globalRows.length === 0) {
        return new NextResponse('Recipe not found', { status: 404 });
      }

      sourceGlobalMealId = globalRows[0].id;
      snapshot = toSnapshot(globalRows[0]);
    }

    if (!snapshot || !snapshot.name) {
      return new NextResponse('Recipe could not be shared', { status: 400 });
    }

    const token = uuidv4();
    const expiresAt = addDays(new Date(), 30);

    await db.insert(mealShares).values({
      id: uuidv4(),
      token,
      createdBy: userId,
      sourceMealId,
      sourceGlobalMealId,
      sourceHouseholdId,
      snapshot,
      expiresAt,
      createdAt: new Date(),
    });

    const res = NextResponse.json({
      token,
      shareUrl: buildShareUrl(token),
      expiresAt,
    });
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    console.error('[MEAL_SHARE_POST]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
