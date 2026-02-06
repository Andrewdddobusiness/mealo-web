import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { validateRecordId } from '@/lib/validation';
import { ensureMealsNutritionColumn, getMealsSelect } from '@/db/compat';
import { db } from '../../../../../../db';
import { meals, household_members } from '../../../../../../db/schema';
import { and, eq } from 'drizzle-orm';
import {
  buildNutritionCacheKey,
  computeMealNutritionFromIngredients,
  hasIngredientQuantities,
} from '@/lib/nutrition/computeMealNutrition';
import { AiTimeoutError, AiValidationError, AiProviderError } from '@/lib/ai/generateMeal';
import { canRecomputeNutritionForUser } from '@/lib/nutrition/recomputeRateLimit';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return new NextResponse('Unauthorized', { status: 401 });

    if (!db) return new NextResponse('Database not configured', { status: 500 });

    const hasNutrition = await ensureMealsNutritionColumn(db);
    if (!hasNutrition) {
      return NextResponse.json(
        {
          error: 'nutrition_unavailable',
          message: 'Nutrition facts are not available yet.',
        },
        { status: 501 },
      );
    }

    const { id: idRaw } = await params;
    const id = validateRecordId(idRaw);
    if (!id) return new NextResponse('Invalid id', { status: 400 });

    if (!canRecomputeNutritionForUser(userId)) {
      const res = new NextResponse('Too many requests', { status: 429 });
      res.headers.set('retry-after', '25');
      return res;
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
    const hasSomeQuantity = hasIngredientQuantities(ingredients);

    if (!hasSomeQuantity) {
      return NextResponse.json(
        {
          error: 'missing_quantities',
          message: 'Add ingredient quantities to calculate nutrition.',
        },
        { status: 422 },
      );
    }

    const nutrition = await computeMealNutritionFromIngredients(
      { mealName: meal.name, ingredients },
      {
        cacheKey: buildNutritionCacheKey({ mealName: meal.name, ingredients }),
      },
    );

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
