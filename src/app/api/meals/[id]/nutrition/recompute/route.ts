import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { validateRecordId } from '@/lib/validation';
import { getMealsSelect, hasMealsNutritionColumn } from '@/db/compat';
import { db } from '../../../../../../db';
import { meals, household_members } from '../../../../../../db/schema';
import { and, eq } from 'drizzle-orm';
import { computeMealNutritionFromIngredients } from '@/lib/nutrition/computeMealNutrition';
import { AiTimeoutError, AiValidationError, AiProviderError } from '@/lib/ai/generateMeal';

const rateLimitByUser = new Map<string, number>();
const RATE_LIMIT_WINDOW_MS = 25_000;

function canRecompute(userId: string): boolean {
  const now = Date.now();
  const prev = rateLimitByUser.get(userId) ?? 0;
  if (now - prev < RATE_LIMIT_WINDOW_MS) return false;
  rateLimitByUser.set(userId, now);
  return true;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return new NextResponse('Unauthorized', { status: 401 });

    if (!db) return new NextResponse('Database not configured', { status: 500 });

    const hasNutrition = await hasMealsNutritionColumn(db);
    if (!hasNutrition) {
      return NextResponse.json(
        { error: 'nutrition_unavailable', message: 'Nutrition facts are not available yet.' },
        { status: 501 },
      );
    }

    const { id: idRaw } = await params;
    const id = validateRecordId(idRaw);
    if (!id) return new NextResponse('Invalid id', { status: 400 });

    if (!canRecompute(userId)) {
      return new NextResponse('Too many requests', { status: 429 });
    }

    const mealsSelect = await getMealsSelect(db);
    const mealRows = await db.select(mealsSelect).from(meals).where(eq(meals.id, id)).limit(1);
    const meal = mealRows[0];
    if (!meal) return new NextResponse('Meal not found', { status: 404 });

    const membership = await db
      .select()
      .from(household_members)
      .where(and(eq(household_members.householdId, meal.householdId), eq(household_members.userId, userId)))
      .limit(1);

    if (membership.length === 0) return new NextResponse('Forbidden', { status: 403 });

    const ingredients = Array.isArray(meal.ingredients) ? meal.ingredients : [];
    const hasSomeQuantity = ingredients.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const q = (item as any).quantity;
      return typeof q === 'number' ? Number.isFinite(q) && q > 0 : typeof q === 'string' ? Number(q) > 0 : false;
    });

    if (!hasSomeQuantity) {
      return NextResponse.json(
        {
          error: 'missing_quantities',
          message: 'Add ingredient quantities to calculate nutrition.',
        },
        { status: 422 },
      );
    }

    const nutrition = await computeMealNutritionFromIngredients({ mealName: meal.name, ingredients: meal.ingredients });

    await db.update(meals).set({ nutrition }).where(eq(meals.id, id));

    const res = NextResponse.json({ nutrition });
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    if (error instanceof AiTimeoutError) {
      return NextResponse.json({ error: 'ai_timeout', message: error.message }, { status: 504 });
    }
    if (error instanceof AiValidationError) {
      const reason = typeof (error as any).nutritionReason === 'string' ? (error as any).nutritionReason : 'invalid';
      const status = reason === 'missing_quantities' ? 422 : 400;
      return NextResponse.json({ error: reason, message: error.message }, { status });
    }
    if (error instanceof AiProviderError) {
      return NextResponse.json({ error: 'ai_provider', message: error.message }, { status: 502 });
    }
    console.error('[MEAL_NUTRITION_RECOMPUTE]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
