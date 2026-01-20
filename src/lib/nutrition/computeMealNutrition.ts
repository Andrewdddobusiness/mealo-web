import { AiConfigError, AiProviderError, AiTimeoutError, AiValidationError, extractJsonObject } from '@/lib/ai/generateMeal';
import { normalizeWhitespace, stripControlChars } from '@/lib/validation';

export type NutritionFacts = {
  caloriesKcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
  sugarG?: number;
  sodiumMg?: number;
  perServing?: boolean;
  servings?: number;
  isEstimate?: boolean;
  computedAt?: string;
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
};

const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';

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

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const v = Math.max(min, Math.min(max, value));
  return v;
}

function normalizeNutritionFacts(raw: unknown): NutritionFacts {
  if (!raw || typeof raw !== 'object') throw new AiValidationError('Nutrition response did not match the expected schema.');
  const obj = raw as Record<string, unknown>;

  const nutritionRaw =
    obj.nutrition && typeof obj.nutrition === 'object'
      ? (obj.nutrition as Record<string, unknown>)
      : obj;

  const nutrition: NutritionFacts = {};
  nutrition.caloriesKcal = clampNumber(nutritionRaw.caloriesKcal, 0, 50_000);
  nutrition.proteinG = clampNumber(nutritionRaw.proteinG, 0, 5_000);
  nutrition.carbsG = clampNumber(nutritionRaw.carbsG, 0, 5_000);
  nutrition.fatG = clampNumber(nutritionRaw.fatG, 0, 5_000);
  nutrition.fiberG = clampNumber(nutritionRaw.fiberG, 0, 5_000);
  nutrition.sugarG = clampNumber(nutritionRaw.sugarG, 0, 5_000);
  nutrition.sodiumMg = clampNumber(nutritionRaw.sodiumMg, 0, 200_000);

  if (typeof nutritionRaw.perServing === 'boolean') nutrition.perServing = nutritionRaw.perServing;
  if (typeof nutritionRaw.servings === 'number' && Number.isFinite(nutritionRaw.servings) && nutritionRaw.servings > 0) {
    nutrition.servings = Math.min(100, Math.max(1, Math.round(nutritionRaw.servings)));
  }
  if (typeof nutritionRaw.isEstimate === 'boolean') nutrition.isEstimate = nutritionRaw.isEstimate;

  const computedAt = typeof nutritionRaw.computedAt === 'string' ? nutritionRaw.computedAt.trim() : '';
  if (computedAt) nutrition.computedAt = computedAt;

  const hasAny =
    nutrition.caloriesKcal != null ||
    nutrition.proteinG != null ||
    nutrition.carbsG != null ||
    nutrition.fatG != null ||
    nutrition.fiberG != null ||
    nutrition.sugarG != null ||
    nutrition.sodiumMg != null;

  if (!hasAny) throw new AiValidationError('Nutrition response was missing values.');
  return nutrition;
}

function normalizeText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return normalizeWhitespace(stripControlChars(value)).slice(0, maxLen);
}

export async function computeMealNutritionFromIngredients(input: {
  mealName?: string;
  ingredients: unknown;
  servings?: number;
}): Promise<NutritionFacts> {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  if (provider !== 'gemini') throw new AiConfigError(`Unsupported AI provider: ${provider}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiConfigError('GEMINI_API_KEY is not configured.');

  const ingredients = Array.isArray(input.ingredients) ? input.ingredients : [];
  if (ingredients.length === 0) {
    const err = new AiValidationError('Missing ingredients.');
    (err as any).nutritionReason = 'missing_ingredients';
    throw err;
  }

  const mealName = normalizeText(input.mealName, 80);
  const servings = typeof input.servings === 'number' && Number.isFinite(input.servings) && input.servings > 0 ? input.servings : undefined;

  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const systemInstruction = [
    'You compute nutrition facts for a meal planning app.',
    'Return ONLY valid JSON (no markdown, no code fences, no explanations).',
    'If you cannot compute nutrition because ingredient quantities/units are missing or ambiguous, return { "error": "missing_quantities", "message": string }.',
    'Otherwise return { "nutrition": {',
    '  "caloriesKcal": number,',
    '  "proteinG": number,',
    '  "carbsG": number,',
    '  "fatG": number,',
    '  "fiberG": number|null,',
    '  "sugarG": number|null,',
    '  "sodiumMg": number|null,',
    '  "perServing": boolean,',
    '  "servings": number|null,',
    '  "isEstimate": boolean',
    '} }.',
    'Rules:',
    '- Prefer totals for the whole recipe (perServing=false) unless servings is provided.',
    '- If you must guess portion sizes or missing quantities, set isEstimate=true.',
    '- Use grams for macros and kcal for calories.',
    '- Keep outputs realistic and non-negative.',
  ].join('\n');

  const userPromptLines: string[] = [];
  if (mealName) userPromptLines.push(`Meal name: ${mealName}`);
  if (servings) userPromptLines.push(`Servings: ${servings}`);
  userPromptLines.push('Ingredients JSON:');
  userPromptLines.push(JSON.stringify(ingredients));

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userPromptLines.join('\n') }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: 0.25,
          maxOutputTokens: 700,
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

  if (parsed && typeof parsed === 'object' && typeof (parsed as any).error === 'string') {
    const code = String((parsed as any).error).trim().toLowerCase();
    if (code === 'missing_quantities') {
      const err = new AiValidationError(
        typeof (parsed as any).message === 'string' && (parsed as any).message.trim()
          ? String((parsed as any).message).trim()
          : 'Not enough ingredient detail to compute nutrition.',
      );
      (err as any).nutritionReason = 'missing_quantities';
      throw err;
    }
  }

  const nutrition = normalizeNutritionFacts(parsed);
  nutrition.isEstimate = nutrition.isEstimate !== false;
  nutrition.computedAt = new Date().toISOString();
  return nutrition;
}
