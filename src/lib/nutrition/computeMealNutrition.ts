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
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 500;

type UnknownRecord = Record<string, unknown>;
type NutritionCacheEntry = { nutrition: NutritionFacts; expiresAtMs: number };

const nutritionCacheByKey = new Map<string, NutritionCacheEntry>();
const inFlightNutritionByKey = new Map<string, Promise<NutritionFacts>>();

export type ComputeMealNutritionOptions = {
  timeoutMs?: number;
  cacheKey?: string;
  useCache?: boolean;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractTextFromGemini(json: GeminiGenerateResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') throw new AiTimeoutError('AI provider request timed out.');
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

function cloneNutrition(input: NutritionFacts): NutritionFacts {
  return { ...input };
}

function parseDurationMs(value: unknown, fallback: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(24 * 60 * 60 * 1000, Math.max(1_000, Math.round(parsed)));
}

function getNutritionCacheTtlMs(): number {
  return parseDurationMs(process.env.NUTRITION_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
}

function normalizeNumberForCache(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  const asText = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(4);
  return asText.replace(/\.?0+$/, '');
}

function normalizeQuantityForCache(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return normalizeNumberForCache(value);
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) return normalizeNumberForCache(parsed);
  return normalizeText(trimmed, 24).toLowerCase();
}

export function hasIngredientQuantities(ingredients: unknown): boolean {
  if (!Array.isArray(ingredients)) return false;
  return ingredients.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const quantity = (item as Record<string, unknown>).quantity;
    if (typeof quantity === 'number') return Number.isFinite(quantity) && quantity > 0;
    if (typeof quantity === 'string') {
      const parsed = Number(quantity.trim());
      return Number.isFinite(parsed) && parsed > 0;
    }
    return false;
  });
}

export function buildNutritionCacheKey(input: {
  mealName?: string;
  ingredients: unknown;
  servings?: number;
}): string {
  const mealName = normalizeText(input.mealName, 80).toLowerCase();
  const servings =
    typeof input.servings === 'number' && Number.isFinite(input.servings) && input.servings > 0
      ? normalizeNumberForCache(input.servings)
      : '';
  const ingredients = Array.isArray(input.ingredients) ? input.ingredients : [];
  const parts = ingredients
    .map((raw) => {
      if (!raw || typeof raw !== 'object') {
        if (typeof raw === 'string') {
          const text = normalizeText(raw, 80).toLowerCase();
          return text ? `${text}|` : '';
        }
        return '';
      }
      const row = raw as Record<string, unknown>;
      const name = normalizeText(row.name ?? row.ingredientKey, 80).toLowerCase();
      if (!name) return '';
      const quantity = normalizeQuantityForCache(row.quantity);
      const unit = normalizeText(row.unit, 24).toLowerCase();
      return `${name}|${quantity}|${unit}`;
    })
    .filter(Boolean)
    .sort();
  return `v1|${mealName}|${servings}|${parts.join(';')}`;
}

function pruneNutritionCache(nowMs: number): void {
  for (const [key, value] of nutritionCacheByKey.entries()) {
    if (value.expiresAtMs <= nowMs) {
      nutritionCacheByKey.delete(key);
    }
  }

  while (nutritionCacheByKey.size > MAX_CACHE_ENTRIES) {
    const oldestKey = nutritionCacheByKey.keys().next().value as string | undefined;
    if (!oldestKey) break;
    nutritionCacheByKey.delete(oldestKey);
  }
}

function getCachedNutrition(cacheKey: string, nowMs: number): NutritionFacts | null {
  const entry = nutritionCacheByKey.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    nutritionCacheByKey.delete(cacheKey);
    return null;
  }
  return cloneNutrition(entry.nutrition);
}

function setCachedNutrition(cacheKey: string, nutrition: NutritionFacts, nowMs: number): void {
  const ttlMs = getNutritionCacheTtlMs();
  nutritionCacheByKey.set(cacheKey, {
    nutrition: cloneNutrition(nutrition),
    expiresAtMs: nowMs + ttlMs,
  });
  pruneNutritionCache(nowMs);
}

export function clearNutritionComputationCacheForTests(): void {
  nutritionCacheByKey.clear();
  inFlightNutritionByKey.clear();
}

async function computeMealNutritionFromIngredientsUncached(
  input: {
    mealName?: string;
    ingredients: unknown;
    servings?: number;
  },
  timeoutMs: number,
): Promise<NutritionFacts> {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  if (provider !== 'gemini') throw new AiConfigError(`Unsupported AI provider: ${provider}`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiConfigError('GEMINI_API_KEY is not configured.');

  const ingredients = Array.isArray(input.ingredients) ? input.ingredients : [];
  if (ingredients.length === 0) {
    const err = new AiValidationError('Missing ingredients.');
    (err as AiValidationError & { nutritionReason?: string }).nutritionReason = 'missing_ingredients';
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
    timeoutMs,
  );

  const json = (await res.json().catch(() => null)) as GeminiGenerateResponse | null;
  if (!res.ok) {
    const message = json?.error?.message || `Gemini request failed (${res.status}).`;
    throw new AiProviderError(message);
  }

  const text = extractTextFromGemini(json ?? {});
  const parsed = extractJsonObject(text);

  if (isRecord(parsed) && typeof parsed.error === 'string') {
    const code = parsed.error.trim().toLowerCase();
    if (code === 'missing_quantities') {
      const err = new AiValidationError(
        typeof parsed.message === 'string' && parsed.message.trim()
          ? parsed.message.trim()
          : 'Not enough ingredient detail to compute nutrition.',
      );
      (err as AiValidationError & { nutritionReason?: string }).nutritionReason = 'missing_quantities';
      throw err;
    }
  }

  const nutrition = normalizeNutritionFacts(parsed);
  nutrition.isEstimate = nutrition.isEstimate !== false;
  nutrition.computedAt = new Date().toISOString();
  return nutrition;
}

export async function computeMealNutritionFromIngredients(
  input: {
    mealName?: string;
    ingredients: unknown;
    servings?: number;
  },
  options: ComputeMealNutritionOptions = {},
): Promise<NutritionFacts> {
  const timeoutMs = parseDurationMs(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const requestedCacheKey = typeof options.cacheKey === 'string' ? options.cacheKey.trim() : '';
  const cacheKey = requestedCacheKey || buildNutritionCacheKey(input);
  const useCache = options.useCache !== false && cacheKey.length > 0;
  const nowMs = Date.now();

  if (useCache) {
    const cached = getCachedNutrition(cacheKey, nowMs);
    if (cached) return cached;

    const inFlight = inFlightNutritionByKey.get(cacheKey);
    if (inFlight) {
      const shared = await inFlight;
      return cloneNutrition(shared);
    }
  }

  const run = computeMealNutritionFromIngredientsUncached(input, timeoutMs).then((nutrition) => {
    if (useCache) {
      setCachedNutrition(cacheKey, nutrition, Date.now());
    }
    return nutrition;
  });

  if (useCache) {
    inFlightNutritionByKey.set(cacheKey, run);
  }

  try {
    const nutrition = await run;
    return cloneNutrition(nutrition);
  } finally {
    if (useCache) {
      inFlightNutritionByKey.delete(cacheKey);
    }
  }
}
