import { normalizeCuisine, normalizeMealName, normalizeTitleCase, normalizeWhitespace } from '../normalizeMeal';

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
  unit?: string;
  category?: string;
};

export type GeneratedMeal = {
  name: string;
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

function safeTrim(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
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

function extractJsonObject(text: string): unknown {
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

  const unit = safeTrim(obj.unit, 16);
  const category = safeTrim(obj.category, 24);

  const quantity =
    typeof obj.quantity === 'number' && Number.isFinite(obj.quantity) && obj.quantity > 0 ? obj.quantity : undefined;

  return { name, quantity, unit, category };
}

function validateGeneratedMeal(raw: unknown, maxIngredients: number): GeneratedMeal {
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

  const cuisine = normalizeCuisine(obj.cuisine)?.slice(0, MAX_CUISINE_LENGTH);

  const ingredientsRaw = Array.isArray(obj.ingredients) ? obj.ingredients : [];
  const ingredients = ingredientsRaw.map(normalizeIngredient).filter(Boolean) as GeneratedMealIngredient[];

  if (ingredients.length === 0) {
    throw new AiValidationError('AI response is missing a usable ingredients list.');
  }

  return {
    name,
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
    '{ "meal": { "name": string, "cuisine": string|null, "ingredients": [ { "name": string, "quantity": number|null, "unit": string|null, "category": string|null } ] } }',
    'Rules:',
    `- ingredients must be 1..${maxIngredients} items`,
    '- each ingredient.name must be non-empty',
    '- prefer including quantity + unit for every ingredient',
    '- unit should be a short string (e.g. g, kg, ml, cup, tbsp, tsp, slice, piece)',
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

