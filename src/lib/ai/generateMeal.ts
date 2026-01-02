import { normalizeMealName, normalizeTitleCase, normalizeWhitespace } from '../normalizeMeal';

export type GenerateMealInput = {
  prompt: string;
  cuisine?: string;
  diet?: string;
  servings?: number;
  maxIngredients?: number;
};

export type GeneratedMealIngredient = {
  name: string;
  quantity?: number;
  unit: string;
  category?: string;
};

export type GeneratedMeal = {
  name: string;
  cuisines?: string[];
  cuisine?: string;
  ingredients: GeneratedMealIngredient[];
};

export class AiConfigError extends Error {
  readonly name = 'AiConfigError';
}

export class AiProviderError extends Error {
  readonly name = 'AiProviderError';
}

export class AiValidationError extends Error {
  readonly name = 'AiValidationError';
}

export class AiTimeoutError extends Error {
  readonly name = 'AiTimeoutError';
}

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
const MAX_PROMPT_LENGTH = 800;
const MAX_OPTION_LENGTH = 80;
const MAX_NAME_LENGTH = 80;
const MAX_CUISINE_LENGTH = 40;

const ALLOWED_CUISINES = [
  'American',
  'Italian',
  'Mexican',
  'Greek',
  'French',
  'Spanish',
  'Mediterranean',
  'Middle Eastern',
  'Indian',
  'Thai',
  'Vietnamese',
  'Chinese',
  'Japanese',
  'Korean',
  'Brazilian',
  'Caribbean',
  'African',
  'Vegetarian',
  'Vegan',
] as const;

const ALLOWED_UNITS = [
  'g',
  'kg',
  'oz',
  'lb',
  'ml',
  'l',
  'cup',
  'tbsp',
  'tsp',
  'slice',
  'loaf',
  'piece',
  'can',
  'pkg',
  'whole',
] as const;

const UNIT_SYNONYMS: Record<string, (typeof ALLOWED_UNITS)[number]> = {
  gram: 'g',
  grams: 'g',
  kilogram: 'kg',
  kilograms: 'kg',
  ounce: 'oz',
  ounces: 'oz',
  pound: 'lb',
  pounds: 'lb',
  lbs: 'lb',
  milliliter: 'ml',
  milliliters: 'ml',
  millilitre: 'ml',
  millilitres: 'ml',
  liter: 'l',
  liters: 'l',
  litre: 'l',
  litres: 'l',
  cups: 'cup',
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  slices: 'slice',
  pieces: 'piece',
  cans: 'can',
  package: 'pkg',
  packages: 'pkg',
  pack: 'pkg',
  packs: 'pkg',
  stalk: 'piece',
  stalks: 'piece',
  stock: 'piece',
  stocks: 'piece',
};

function normalizeKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

const CUISINE_BY_KEY = new Map<string, (typeof ALLOWED_CUISINES)[number]>(
  ALLOWED_CUISINES.map((cuisine) => [normalizeKey(cuisine), cuisine]),
);

const UNIT_BY_KEY = new Map<string, (typeof ALLOWED_UNITS)[number]>(ALLOWED_UNITS.map((unit) => [normalizeKey(unit), unit]));

function safeTrim(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

function normalizeUnit(raw: unknown): (typeof ALLOWED_UNITS)[number] | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = normalizeWhitespace(raw);
  if (!trimmed) return undefined;

  const normalized = normalizeKey(trimmed.replace(/[()]/g, ' ').replace(/\./g, ' '));
  const direct = UNIT_BY_KEY.get(normalized);
  if (direct) return direct;

  const synonym = UNIT_SYNONYMS[normalized];
  if (synonym) return synonym;

  return undefined;
}

function inferUnitFromIngredient(name: string, category?: string): (typeof ALLOWED_UNITS)[number] {
  const key = normalizeKey(name);

  // More specific name-based rules first.
  if (/\b(oil|vinegar)\b/.test(key)) return 'tbsp';
  if (/\b(soy sauce|fish sauce|oyster sauce)\b/.test(key)) return 'tbsp';
  if (/\b(water|milk|cream|broth|stock|juice|wine)\b/.test(key)) return 'ml';
  if (/\b(salt|pepper|spice|powder|seasoning|cinnamon|paprika|cumin|oregano|basil|chili)\b/.test(key)) return 'tsp';

  if (/\b(loaf)\b/.test(key)) return 'loaf';
  if (/\b(bread)\b/.test(key)) return 'slice';
  if (/\b(egg|eggs)\b/.test(key)) return 'piece';
  if (/\b(canned|tin)\b/.test(key)) return 'can';

  // Category-based fallback.
  const cat = normalizeKey(category ?? '');
  if (cat === 'produce') return 'piece';
  if (cat === 'bakery') return 'slice';
  if (cat === 'meat') return 'g';
  if (cat === 'dairy') return 'g';
  if (cat === 'pantry') return 'g';

  // Ingredient-name fallback for common solids.
  if (/\b(rice|pasta|flour|sugar|cheese|beef|chicken|pork|fish|shrimp|tofu|quinoa|lentil|bean|butter)\b/.test(key)) {
    return 'g';
  }

  // Safe default that works for many produce items (onions, herbs, etc.).
  return 'piece';
}

function normalizeCuisines(raw: unknown): (typeof ALLOWED_CUISINES)[number][] {
  const items: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') items.push(entry);
    }
  } else if (typeof raw === 'string') {
    items.push(raw);
  }

  const out: (typeof ALLOWED_CUISINES)[number][] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const normalizedText = normalizeKey(item);
    if (!normalizedText) continue;

    // If the model returns prose like "Japanese – Italian fusion", extract any known cuisines.
    const embedded = ALLOWED_CUISINES.filter((cuisine) => normalizedText.includes(normalizeKey(cuisine)));
    if (embedded.length > 0) {
      for (const cuisine of embedded) {
        const key = normalizeKey(cuisine);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cuisine);
        if (out.length >= 2) return out;
      }
      continue;
    }

    // Direct match or basic splitting fallbacks.
    const parts = normalizedText
      .replace(/[–—]/g, '-')
      .split(/[,/|+&-]|\band\b/gi)
      .map((p) => normalizeWhitespace(p))
      .filter(Boolean);

    for (const part of parts.length ? parts : [item]) {
      const direct = CUISINE_BY_KEY.get(normalizeKey(part));
      if (!direct) continue;
      const key = normalizeKey(direct);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(direct);
      if (out.length >= 2) return out;
    }
  }

  return out;
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

function clampMaxIngredients(value: unknown): number {
  const n = clampInt(value, 1, 30);
  return n ?? DEFAULT_MAX_INGREDIENTS;
}

function buildUserPrompt(input: GenerateMealInput): string {
  const cuisine = safeTrim(input.cuisine, MAX_OPTION_LENGTH);
  const diet = safeTrim(input.diet, MAX_OPTION_LENGTH);
  const servings = clampInt(input.servings, 1, 20);
  const maxIngredients = clampMaxIngredients(input.maxIngredients);

  const lines: string[] = [];
  lines.push(`User prompt: ${normalizeWhitespace(input.prompt)}`);
  if (cuisine) lines.push(`Cuisine: ${cuisine}`);
  if (diet) lines.push(`Diet / constraints: ${diet}`);
  if (servings) lines.push(`Servings: ${servings}`);
  lines.push(`Max ingredients: ${maxIngredients}`);
  return lines.join('\n');
}

function extractTextFromGemini(json: GeminiGenerateResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new AiValidationError('AI returned an empty response.');

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Try to recover from accidental prose/formatting by extracting the first JSON object.
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) {
      throw new AiValidationError('AI returned a non-JSON response.');
    }
    const slice = trimmed.slice(first, last + 1);
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      throw new AiValidationError('AI returned invalid JSON.');
    }
  }
}

function normalizeIngredient(raw: unknown): GeneratedMealIngredient | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const nameRaw = typeof obj.name === 'string' ? obj.name : '';
  const name = normalizeTitleCase(nameRaw).slice(0, MAX_NAME_LENGTH);
  if (!name) return null;

  const category = safeTrim(obj.category, 24);
  const unit = normalizeUnit(obj.unit) ?? inferUnitFromIngredient(name, category);

  const quantity =
    typeof obj.quantity === 'number' && Number.isFinite(obj.quantity) && obj.quantity > 0 ? obj.quantity : undefined;

  return { name, quantity, unit, category };
}

export function validateGeneratedMeal(raw: unknown, maxIngredients: number): GeneratedMeal {
  const root =
    raw && typeof raw === 'object' && (raw as any).meal && typeof (raw as any).meal === 'object'
      ? ((raw as any).meal as unknown)
      : raw;

  if (!root || typeof root !== 'object') {
    throw new AiValidationError('AI response did not match the expected schema.');
  }

  const obj = root as Record<string, unknown>;
  const name = normalizeMealName(obj.name)?.slice(0, MAX_NAME_LENGTH);
  if (!name) throw new AiValidationError('AI response is missing meal.name.');

  const cuisines = normalizeCuisines(obj.cuisines ?? obj.cuisine);
  const cuisine = cuisines.length ? cuisines.join(', ').slice(0, MAX_CUISINE_LENGTH) : undefined;

  const ingredientsRaw = Array.isArray(obj.ingredients) ? obj.ingredients : [];
  const ingredients = ingredientsRaw.map(normalizeIngredient).filter(Boolean) as GeneratedMealIngredient[];

  if (ingredients.length === 0) {
    throw new AiValidationError('AI response is missing a usable ingredients list.');
  }

  return {
    name,
    cuisines: cuisines.length ? cuisines : undefined,
    cuisine,
    ingredients: ingredients.slice(0, Math.max(1, maxIngredients)),
  };
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

async function generateMealWithGemini(input: GenerateMealInput): Promise<GeneratedMeal> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiConfigError('GEMINI_API_KEY is not configured.');

  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const maxIngredients = clampMaxIngredients(input.maxIngredients);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const systemInstruction = [
    'You generate meal recipes for a meal planning app.',
    'Return ONLY valid JSON (no markdown, no code fences, no explanations).',
    'The JSON MUST match exactly this shape:',
    '{ "meal": { "name": string, "cuisines": string[]|null, "ingredients": [ { "name": string, "quantity": number|null, "unit": string, "category": string|null } ] } }',
    'Rules:',
    `- cuisines must be null OR 1..2 items picked ONLY from: ${ALLOWED_CUISINES.join(', ')}`,
    '- if the meal is a fusion, include multiple cuisines (max 2) rather than inventing a new cuisine name',
    `- ingredients must be 1..${maxIngredients} items`,
    '- each ingredient.name must be non-empty',
    '- prefer including quantity + unit for every ingredient',
    `- unit must be one of: ${ALLOWED_UNITS.join(', ')} (never null; choose the closest match if unsure)`,
    '- category should be one of: Produce, Pantry, Meat, Dairy, Bakery, Other (or null)',
  ].join('\n');

  const userPrompt = buildUserPrompt(input);

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 900,
          responseMimeType: 'application/json',
        },
      }),
    },
    20_000,
  );

  const json = (await res.json().catch(() => null)) as GeminiGenerateResponse | null;

  if (!res.ok) {
    const message = json?.error?.message || `Gemini request failed (${res.status}).`;
    throw new AiProviderError(message);
  }

  const text = extractTextFromGemini(json ?? {});
  const parsed = extractJsonObject(text);
  return validateGeneratedMeal(parsed, maxIngredients);
}

export function validateGenerateMealInput(input: GenerateMealInput) {
  const prompt = normalizeWhitespace(input.prompt || '');
  if (!prompt) throw new AiValidationError('Missing required field: prompt');
  if (prompt.length > MAX_PROMPT_LENGTH) throw new AiValidationError(`Prompt is too long (max ${MAX_PROMPT_LENGTH}).`);

  const cuisine = safeTrim(input.cuisine, MAX_OPTION_LENGTH);
  const diet = safeTrim(input.diet, MAX_OPTION_LENGTH);
  const servings = clampInt(input.servings, 1, 20);
  const maxIngredients = clampMaxIngredients(input.maxIngredients);

  return {
    prompt,
    cuisine,
    diet,
    servings,
    maxIngredients,
  } satisfies GenerateMealInput;
}

export async function generateMeal(input: GenerateMealInput): Promise<GeneratedMeal> {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

  if (provider === 'gemini') {
    return generateMealWithGemini(input);
  }

  throw new AiConfigError(`Unsupported AI provider: ${provider}`);
}
