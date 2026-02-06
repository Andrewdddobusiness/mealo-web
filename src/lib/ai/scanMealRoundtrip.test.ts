import assert from 'node:assert/strict';
import test from 'node:test';

import { scanMealFromImage } from './scanMeal';

const ORIGINAL_ENV = { ...process.env };

function buildGeminiResponse(payload: unknown) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(payload) }],
        },
      },
    ],
  };
}

test('scanMealFromImage clamps and echoes requested focus bbox for meal scans', async (t) => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key';

  const originalFetch = global.fetch;
  global.fetch = (async () => {
    return new Response(
      JSON.stringify(
        buildGeminiResponse({
          kind: 'meal',
          meal: {
            name: 'Chicken Rice Bowl',
            ingredients: [{ name: 'Chicken breast', quantity: 180, unit: 'g', category: 'Meat' }],
            instructions: ['Season chicken and sear.'],
          },
          confidence: 0.84,
          candidates: [{ name: 'Chicken bowl', confidence: 0.7 }],
          region: {
            bbox: { x: 0.1, y: 0.2, width: 0.45, height: 0.5 },
          },
          detections: [
            {
              name: 'Chicken rice bowl',
              confidence: 0.84,
              bbox: { x: 0.12, y: 0.23, width: 0.42, height: 0.46 },
            },
          ],
        }),
      ),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env = { ...ORIGINAL_ENV };
  });

  const result = await scanMealFromImage({
    imageBase64: 'ZmFrZQ==',
    mimeType: 'image/jpeg',
    focusBbox: { x: -0.2, y: 0.9, width: 0.5, height: 0.3 },
  });

  assert.equal(result.kind, 'meal');
  assert.deepEqual(result.focus?.requestedBbox, {
    x: 0,
    y: 0.7,
    width: 0.5,
    height: 0.3,
  });
  assert.ok(result.region?.bbox);
  assert.ok(Array.isArray(result.detections) && result.detections.length === 1);
});

test('scanMealFromImage preserves focus metadata through recipe fallback', async (t) => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key';

  const originalFetch = global.fetch;
  let fetchCount = 0;

  global.fetch = (async () => {
    fetchCount += 1;
    const payload =
      fetchCount === 1
        ? buildGeminiResponse({ error: 'not_food' })
        : buildGeminiResponse({
            kind: 'recipes',
            recipes: [
              {
                id: 'recipe-1',
                recipe: {
                  name: 'Simple Marinara Pasta',
                  ingredients: [{ name: 'Pasta', quantity: 250, unit: 'g', category: 'Pantry' }],
                  instructions: ['Boil pasta and simmer sauce.'],
                },
                confidence: 0.78,
              },
            ],
          });

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  t.after(() => {
    global.fetch = originalFetch;
    process.env = { ...ORIGINAL_ENV };
  });

  const result = await scanMealFromImage({
    imageBase64: 'ZmFrZQ==',
    mimeType: 'image/jpeg',
    focusBbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
  });

  assert.equal(fetchCount, 2);
  assert.equal(result.kind, 'recipes');
  assert.equal(result.recipes?.length, 1);
  assert.deepEqual(result.focus?.requestedBbox, {
    x: 0.2,
    y: 0.2,
    width: 0.4,
    height: 0.4,
  });
});
