import { eq } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from '@/db/schema';
import { meals } from '@/db/schema';
import { getMealsColumnAvailability } from '@/db/compat';
import { AiProviderError, AiTimeoutError, AiValidationError } from '@/lib/ai/generateMeal';

import {
  buildNutritionCacheKey,
  computeMealNutritionFromIngredients,
  hasIngredientQuantities,
  type NutritionFacts,
} from './computeMealNutrition';

const AUTO_RECOMPUTE_TIMEOUT_MS = 9_000;
type NutritionReasonError = AiValidationError & { nutritionReason?: unknown };

export type AutoNutritionRecomputeResult = {
  status: 'updated' | 'cleared' | 'skipped';
  reason?: string;
  nutrition?: NutritionFacts;
};

export async function autoRecomputeAndPersistMealNutrition(input: {
  db: NeonHttpDatabase<typeof schema>;
  mealId: string;
  mealName?: string;
  ingredients: unknown;
  loggerTag?: string;
  timeoutMs?: number;
}): Promise<AutoNutritionRecomputeResult> {
  const availability = await getMealsColumnAvailability(input.db);
  if (!availability.nutrition) {
    return { status: 'skipped', reason: 'nutrition_unavailable' };
  }

  const ingredients = Array.isArray(input.ingredients) ? input.ingredients : [];
  if (ingredients.length === 0) {
    await input.db.update(meals).set({ nutrition: null }).where(eq(meals.id, input.mealId));
    return { status: 'cleared', reason: 'missing_ingredients' };
  }

  if (!hasIngredientQuantities(ingredients)) {
    await input.db.update(meals).set({ nutrition: null }).where(eq(meals.id, input.mealId));
    return { status: 'cleared', reason: 'missing_quantities' };
  }

  try {
    const nutrition = await computeMealNutritionFromIngredients(
      {
        mealName: input.mealName,
        ingredients,
      },
      {
        cacheKey: buildNutritionCacheKey({
          mealName: input.mealName,
          ingredients,
        }),
        timeoutMs: input.timeoutMs ?? AUTO_RECOMPUTE_TIMEOUT_MS,
      },
    );

    await input.db.update(meals).set({ nutrition }).where(eq(meals.id, input.mealId));
    return { status: 'updated', nutrition };
  } catch (error) {
    if (error instanceof AiValidationError) {
      const reasonRaw = (error as NutritionReasonError).nutritionReason;
      const reason = typeof reasonRaw === 'string' ? reasonRaw : 'invalid';
      if (reason === 'missing_quantities' || reason === 'missing_ingredients') {
        await input.db.update(meals).set({ nutrition: null }).where(eq(meals.id, input.mealId));
        return { status: 'cleared', reason };
      }
    }

    const tag = input.loggerTag || 'MEAL_NUTRITION_AUTO_RECOMPUTE';
    if (error instanceof AiTimeoutError || error instanceof AiProviderError) {
      console.warn(`[${tag}]`, {
        mealId: input.mealId,
        message: error.message,
      });
    } else {
      console.error(`[${tag}]`, {
        mealId: input.mealId,
        error,
      });
    }

    // Ingredients changed but we couldn't reliably recompute. Clear stale values.
    await input.db.update(meals).set({ nutrition: null }).where(eq(meals.id, input.mealId));
    return { status: 'skipped', reason: 'ai_error' };
  }
}
