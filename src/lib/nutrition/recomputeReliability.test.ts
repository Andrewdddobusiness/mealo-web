import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNutritionCacheKey,
  clearNutritionComputationCacheForTests,
  computeMealNutritionFromIngredients,
  hasIngredientQuantities,
} from './computeMealNutrition';
import {
  canRecomputeNutritionForUser,
  clearNutritionRecomputeRateLimitForTests,
} from './recomputeRateLimit';

const ORIGINAL_ENV = { ...process.env };

function buildMockGeminiResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                nutrition: {
                  caloriesKcal: 640,
                  proteinG: 32,
                  carbsG: 54,
                  fatG: 28,
                  fiberG: 8,
                  sugarG: 10,
                  sodiumMg: 820,
                  perServing: false,
                  servings: 2,
                  isEstimate: true,
                },
              }),
            },
          ],
        },
      },
    ],
  };
}

test('buildNutritionCacheKey is stable across ingredient order and casing', () => {
  const left = buildNutritionCacheKey({
    mealName: 'Chicken Salad',
    ingredients: [
      { name: 'Chicken Breast', quantity: '250', unit: 'g' },
      { name: 'Olive Oil', quantity: 15, unit: 'ml' },
    ],
  });
  const right = buildNutritionCacheKey({
    mealName: '  chicken salad  ',
    ingredients: [
      { name: 'olive oil', quantity: '15.0', unit: 'ML' },
      { name: ' chicken breast ', quantity: 250, unit: ' G ' },
    ],
  });

  assert.equal(left, right);
});

test('hasIngredientQuantities detects positive numeric quantities', () => {
  assert.equal(hasIngredientQuantities([{ name: 'Salt' }]), false);
  assert.equal(hasIngredientQuantities([{ name: 'Salt', quantity: 0 }]), false);
  assert.equal(hasIngredientQuantities([{ name: 'Salt', quantity: -1 }]), false);
  assert.equal(hasIngredientQuantities([{ name: 'Salt', quantity: '0' }]), false);
  assert.equal(hasIngredientQuantities([{ name: 'Salt', quantity: '2' }]), true);
  assert.equal(hasIngredientQuantities([{ name: 'Salt', quantity: 0.5 }]), true);
});

test('computeMealNutritionFromIngredients reuses cache and in-flight requests', async (t) => {
  clearNutritionComputationCacheForTests();
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.NUTRITION_CACHE_TTL_MS = '120000';

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(buildMockGeminiResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    clearNutritionComputationCacheForTests();
    process.env = { ...ORIGINAL_ENV };
  });

  const input = {
    mealName: 'Post-workout bowl',
    ingredients: [
      { name: 'Rice', quantity: 180, unit: 'g' },
      { name: 'Chicken', quantity: 220, unit: 'g' },
    ],
  };

  const [first, second] = await Promise.all([
    computeMealNutritionFromIngredients(input),
    computeMealNutritionFromIngredients(input),
  ]);
  const third = await computeMealNutritionFromIngredients(input);

  assert.equal(fetchCalls, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test('canRecomputeNutritionForUser enforces a fixed 25s window', () => {
  clearNutritionRecomputeRateLimitForTests();

  const baseMs = 1_000_000;
  assert.equal(canRecomputeNutritionForUser('user-1', baseMs), true);
  assert.equal(canRecomputeNutritionForUser('user-1', baseMs + 10_000), false);
  assert.equal(canRecomputeNutritionForUser('user-1', baseMs + 25_001), true);
});
