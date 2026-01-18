import {
  AiConfigError,
  AiProviderError,
  AiTimeoutError,
  AiValidationError,
  type GeneratedMeal,
  extractJsonObject,
  validateGeneratedMeal,
} from './generateMeal';

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
};

const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';
const DEFAULT_MAX_INGREDIENTS = 12;

function extractTextFromGemini(json: GeminiGenerateResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new AiTimeoutError('AI provider request timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function clampMaxIngredients(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_INGREDIENTS;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > 30) return 30;
  return rounded;
}

export async function scanMealFromImage(input: {
  imageBase64: string;
  mimeType: string;
  maxIngredients?: number;
}): Promise<GeneratedMeal> {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  if (provider !== 'gemini') {
    throw new AiConfigError(`Unsupported AI provider: ${provider}`);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiConfigError('GEMINI_API_KEY is not configured.');

  const imageBase64 = typeof input.imageBase64 === 'string' ? input.imageBase64.trim() : '';
  if (!imageBase64) throw new AiValidationError('Missing required image data.');

  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim() : '';
  if (!mimeType.startsWith('image/')) throw new AiValidationError('Invalid image type.');

  const model = process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const maxIngredients = clampMaxIngredients(input.maxIngredients);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const systemInstruction = [
    'You analyze an image for a meal planning app.',
    'The image may show: (a) a cooked meal, (b) meal ingredients, or (c) a recipe (text).',
    'Return ONLY valid JSON (no markdown, no code fences, no explanations).',
    'The JSON MUST be ONE of these shapes:',
    '- { "meal": { "name": string, "cuisines": string[]|null, "ingredients": [ { "name": string, "quantity": number|null, "unit": string, "category": string|null } ] } }',
    '- OR { "error": "not_food" }',
    'Rules:',
    '- If the image is NOT food/ingredients/recipe (e.g. bottle, electronics, people, pets, household objects), return { "error": "not_food" }.',
    '- If uncertain whether it is food/recipe, prefer { "error": "not_food" } rather than guessing.',
    '- Otherwise, make a best-effort identification from the image.',
    `- ingredients must be 1..${maxIngredients} items`,
    '- Each ingredient.name must be a generic ingredient (no brand names).',
    '- Prefer including quantity + unit, but if unsure you may return null quantity.',
    '- unit must never be null; choose a reasonable unit (g, piece, tbsp, tsp, cup, ml, etc.).',
    '- category should be one of: Produce, Pantry, Meat, Dairy, Bakery, Other (or null).',
  ].join('\n');

  const userPrompt = [
    'If the image contains a meal/ingredients/recipe, return the meal name and main ingredients.',
    'If it does not look food-related, return { "error": "not_food" }.',
  ].join('\n');

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType, data: imageBase64 } },
              { text: userPrompt },
            ],
          },
        ],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 900,
          responseMimeType: 'application/json',
        },
      }),
    },
    25_000,
  );

  const json = (await res.json().catch(() => null)) as GeminiGenerateResponse | null;

  if (!res.ok) {
    const message = json?.error?.message || `Gemini request failed (${res.status}).`;
    throw new AiProviderError(message);
  }

  const text = extractTextFromGemini(json ?? {});
  const parsed = extractJsonObject(text);
  const rootError =
    parsed && typeof parsed === 'object'
      ? ((parsed as any).error ?? (parsed as any).meal?.error ?? undefined)
      : undefined;

  if (typeof rootError === 'string' && rootError.trim().toLowerCase() === 'not_food') {
    const error = new AiValidationError('No food found in that photo.');
    (error as any).aiScanReason = 'not_food';
    throw error;
  }

  return validateGeneratedMeal(parsed, maxIngredients);
}
