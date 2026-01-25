import {
  AiConfigError,
  AiProviderError,
  AiTimeoutError,
  AiValidationError,
  type GeneratedMeal,
  extractJsonObject,
  validateGeneratedMeal,
} from "./generateMeal";
import type { ImageSize } from "@/lib/imageSize";

export type ScanRegion = {
  bbox?: { x: number; y: number; width: number; height: number };
  polygon?: Array<{ x: number; y: number }>;
};

export type ScanCandidate = { name: string; confidence?: number };
export type ScanDetection = {
  name: string;
  confidence?: number;
  bbox: { x: number; y: number; width: number; height: number };
};

export type ScanRecipeItem = {
  id: string;
  recipe: GeneratedMeal;
  confidence?: number;
  source?: ScanRegion;
  warnings?: string[];
};

type GeminiGenerateResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { message?: string };
};

const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash";
const DEFAULT_MAX_INGREDIENTS = 12;

function extractTextFromGemini(json: GeminiGenerateResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return clamp(raw, 0, 1);
}

function normalizeBbox(
  raw: unknown,
  imageSize?: ImageSize,
): ScanRegion["bbox"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  let x =
    typeof obj.x === "number" && Number.isFinite(obj.x) ? obj.x : undefined;
  let y =
    typeof obj.y === "number" && Number.isFinite(obj.y) ? obj.y : undefined;
  let width =
    typeof obj.width === "number" && Number.isFinite(obj.width)
      ? obj.width
      : undefined;
  let height =
    typeof obj.height === "number" && Number.isFinite(obj.height)
      ? obj.height
      : undefined;
  if (x == null || y == null || width == null || height == null)
    return undefined;

  // Be tolerant if the model returns pixel bboxes instead of normalized ones.
  // We can normalize safely only when we know the actual image size.
  const looksLikePixels =
    Boolean(imageSize?.width && imageSize?.height) &&
    (x > 2 || y > 2 || width > 2 || height > 2);
  if (looksLikePixels && imageSize) {
    x = x / imageSize.width;
    y = y / imageSize.height;
    width = width / imageSize.width;
    height = height / imageSize.height;
  }

  // Gemini sometimes returns slightly oversized normalized bboxes. Apply a small *adaptive* padding
  // so large objects don't become a full-screen box after clamping.
  const w = clamp(width, 0, 1);
  const h = clamp(height, 0, 1);
  if (w <= 0 || h <= 0) return undefined;

  const maxSide = Math.max(w, h);
  const pad = Math.min(0.02, Math.max(0, (1 - maxSide) / 4));

  const cw = clamp(w + pad * 2, 0.05, 1);
  const ch = clamp(h + pad * 2, 0.05, 1);
  const cx = clamp(clamp(x, 0, 1) - pad, 0, 1 - cw);
  const cy = clamp(clamp(y, 0, 1) - pad, 0, 1 - ch);
  return { x: cx, y: cy, width: cw, height: ch };
}

function normalizeCandidate(raw: unknown): ScanCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return null;
  const confidence = normalizeConfidence(obj.confidence);
  const out: ScanCandidate = { name: name.slice(0, 80) };
  if (confidence != null) out.confidence = confidence;
  return out;
}

function normalizeDetection(raw: unknown, imageSize?: ImageSize): ScanDetection | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return null;
  const bbox = normalizeBbox(obj.bbox, imageSize);
  if (!bbox) return null;
  const confidence = normalizeConfidence(obj.confidence);
  const out: ScanDetection = {
    name: name.slice(0, 80),
    bbox: bbox as { x: number; y: number; width: number; height: number },
  };
  if (confidence != null) out.confidence = confidence;
  return out;
}

function extractRegion(parsed: unknown, imageSize?: ImageSize): ScanRegion | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const regionRaw = (parsed as any).region;
  if (!regionRaw || typeof regionRaw !== "object") return undefined;
  const bbox = normalizeBbox((regionRaw as any).bbox, imageSize);
  if (bbox) return { bbox };
  return undefined;
}

function extractCandidates(parsed: unknown): ScanCandidate[] | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const raw = (parsed as any).candidates;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ScanCandidate[] = [];
  for (const item of raw) {
    const candidate = normalizeCandidate(item);
    if (!candidate) continue;
    const key = candidate.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= 3) break;
  }
  return out.length ? out : undefined;
}

function extractDetections(parsed: unknown, imageSize?: ImageSize): ScanDetection[] | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const raw = (parsed as any).detections;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ScanDetection[] = [];
  for (const item of raw) {
    const detection = normalizeDetection(item, imageSize);
    if (!detection) continue;
    const key = detection.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(detection);
    if (out.length >= 6) break;
  }
  return out.length ? out : undefined;
}

function normalizeWarnings(raw: unknown): string[] {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 200));
    if (out.length >= 8) break;
  }
  return out;
}

function extractRecipeItems(parsed: unknown, maxIngredients: number, imageSize?: ImageSize): ScanRecipeItem[] {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as any;
  const rawItems = Array.isArray(root.recipes)
    ? root.recipes
    : Array.isArray(root.items)
      ? root.items
      : root.recipe
        ? [root]
        : [];

  const out: ScanRecipeItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as any;
    const rawRecipe = obj.recipe ?? obj.meal ?? obj;
    try {
      const recipe = validateGeneratedMeal(rawRecipe, maxIngredients);
      const confidence = normalizeConfidence(obj.confidence);
      const sourceRaw = obj.source ?? {};
      const bbox = normalizeBbox(sourceRaw?.bbox ?? obj.bbox, imageSize);
      const source = bbox ? ({ bbox } satisfies ScanRegion) : undefined;
      const warnings = normalizeWarnings(obj.warnings);
      out.push({
        id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim().slice(0, 64) : `recipe-${out.length + 1}`,
        recipe,
        ...(confidence != null ? { confidence } : null),
        ...(source ? { source } : null),
        ...(warnings.length ? { warnings } : null),
      });
    } catch {
      // ignore invalid recipes
    }
    if (out.length >= 5) break;
  }

  return out;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === "AbortError")
      throw new AiTimeoutError("AI provider request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function clampMaxIngredients(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_MAX_INGREDIENTS;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > 30) return 30;
  return rounded;
}

async function callGeminiVisionParsedJson(input: {
  endpoint: string;
  mimeType: string;
  imageBase64: string;
  systemInstruction: string;
  userPrompt: string;
  timeoutMs: number;
}): Promise<unknown> {
  const res = await fetchWithTimeout(
    input.endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: input.mimeType, data: input.imageBase64 } },
              { text: input.userPrompt },
            ],
          },
        ],
        systemInstruction: { parts: [{ text: input.systemInstruction }] },
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 1400,
          responseMimeType: "application/json",
        },
      }),
    },
    input.timeoutMs,
  );

  const json = (await res
    .json()
    .catch(() => null)) as GeminiGenerateResponse | null;

  if (!res.ok) {
    const message =
      json?.error?.message || `Gemini request failed (${res.status}).`;
    throw new AiProviderError(message);
  }

  const text = extractTextFromGemini(json ?? {});
  return extractJsonObject(text);
}

function isNotFoodError(parsed: unknown): boolean {
  const rootError =
    parsed && typeof parsed === "object"
      ? ((parsed as any).error ?? (parsed as any).meal?.error ?? undefined)
      : undefined;

  return typeof rootError === "string" && rootError.trim().toLowerCase() === "not_food";
}

export async function scanMealFromImage(input: {
  imageBase64: string;
  mimeType: string;
  maxIngredients?: number;
  imageSize?: ImageSize;
  note?: string;
}): Promise<{
  meal: GeneratedMeal;
  kind?: "meal" | "recipes";
  recipes?: ScanRecipeItem[];
  warnings?: string[];
  region?: ScanRegion;
  confidence?: number;
  candidates?: ScanCandidate[];
  detections?: ScanDetection[];
}> {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (provider !== "gemini") {
    throw new AiConfigError(`Unsupported AI provider: ${provider}`);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new AiConfigError("GEMINI_API_KEY is not configured.");

  const imageBase64 =
    typeof input.imageBase64 === "string" ? input.imageBase64.trim() : "";
  if (!imageBase64) throw new AiValidationError("Missing required image data.");

  const mimeType =
    typeof input.mimeType === "string" ? input.mimeType.trim() : "";
  if (!mimeType.startsWith("image/"))
    throw new AiValidationError("Invalid image type.");

  const model =
    process.env.GEMINI_VISION_MODEL ||
    process.env.GEMINI_MODEL ||
    DEFAULT_GEMINI_MODEL;
  const maxIngredients = clampMaxIngredients(input.maxIngredients);
  const userNote =
    typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const systemInstruction = [
    "You analyze an image for a meal planning app.",
    "The image may show: (a) a cooked meal, (b) meal ingredients, or (c) a recipe (text).",
    "Return ONLY valid JSON (no markdown, no code fences, no explanations).",
    "The JSON MUST be ONE of these shapes:",
    '- { "kind": "meal", "meal": { "name": string, "cuisines": string[]|null, "ingredients": [ { "name": string, "quantity": number|null, "unit": string, "category": string|null } ], "instructions": string[] }, "confidence"?: number, "candidates"?: [ { "name": string, "confidence"?: number } ], "region"?: { "bbox"?: { "x": number, "y": number, "width": number, "height": number } }, "detections": [ { "name": string, "confidence"?: number, "bbox": { "x": number, "y": number, "width": number, "height": number } } ] }',
    '- OR { "kind": "recipes", "recipes": [ { "id"?: string, "recipe": { "name": string, "cuisines": string[]|null, "ingredients": [ { "name": string, "quantity": number|null, "unit": string, "category": string|null } ], "instructions": string[] }, "confidence"?: number, "source"?: { "bbox"?: { "x": number, "y": number, "width": number, "height": number } }, "warnings"?: string[] } ], "warnings"?: string[] }',
    '- OR { "error": "not_food" }',
    "Rules:",
    '- If the image contains recipe text (cookbook page, recipe card, recipe on a screen, menu with dish names), return kind="recipes" and extract ALL distinct recipes/dishes you can see (1..5).',
    '- If the image shows food/ingredients (photo), return kind="meal".',
    '- If the image is NOT food/ingredients/recipe text (e.g. electronics, people, pets, cleaning products, household objects), return { "error": "not_food" }.',
    "- Packaged food or beverages (including bottles/cans with drinks) count as food.",
    '- If uncertain whether it is food/recipe text, prefer { "error": "not_food" } rather than guessing.',
    "- Otherwise, make a best-effort identification from the image.",
    `- ingredients must be 1..${maxIngredients} items`,
    "- Each ingredient.name must be a generic ingredient (no brand names).",
    "- Prefer including quantity + unit, but if unsure you may return null quantity.",
    "- unit must never be null; choose a reasonable unit (g, piece, tbsp, tsp, cup, ml, etc.).",
    "- category should be one of: Produce, Pantry, Meat, Dairy, Bakery, Other (or null).",
    "- instructions should be a short list of steps (0..15). If you cannot infer cooking steps from the image, return an empty array.",
    "- If the image contains a clear meal subject, include region.bbox as a best-effort bounding box around the FULL dish/drink/food item (normalized 0..1).",
    '- Bbox coordinates MUST be normalized 0..1 floats where x,y is top-left and width,height are sizes. Do NOT use pixels and do NOT use x2/y2 (right/bottom).',
    "- confidence is optional and should be 0..1 for the primary name.",
    "- candidates (optional) should be 0..3 alternative meal names (no brands), each with optional confidence 0..1.",
    '- IMPORTANT: For kind="meal", the "detections" array is REQUIRED. Identify ALL distinct food items visible (1..6 items). For each food item, provide its name and a bounding box (normalized 0..1 coordinates) around the FULL item. Include confidence 0..1 if possible.',
    "- Each detection.bbox must tightly wrap the individual food item (e.g., if there are 3 dishes on a table, return 3 detections with separate bboxes).",
    '- Detection names should be specific (e.g., "Pad Thai", "Water Bottle", "Fried Rice" rather than just "Food").',
    "- If only a single food item is visible, the detections array should contain exactly 1 detection for that item.",
    '- For kind="recipes", include source.bbox around each recipe section only if it is obvious; otherwise omit it.',
  ].join("\n");

  const userPrompt = [
    'If the image contains recipe text, extract all recipes as kind="recipes".',
    'If the image is a meal photo, return kind="meal".',
    'If it does not look food- or recipe-related, return { "error": "not_food" }.',
    ...(userNote ? [`User note (optional):\n${userNote}`] : []),
  ].join("\n");

  const parsedPrimary = await callGeminiVisionParsedJson({
    endpoint,
    mimeType,
    imageBase64,
    systemInstruction,
    userPrompt,
    timeoutMs: 25_000,
  });

  if (isNotFoodError(parsedPrimary)) {
    const recipeOnlyInstruction = [
      "You extract recipes from an image for a meal planning app.",
      "The image may show a cookbook page, recipe card, recipe on a screen, or a menu/meal plan with multiple dishes.",
      "Return ONLY valid JSON (no markdown, no code fences, no explanations).",
      'The JSON MUST be one of: { "recipes": [ { "recipe": { "name": string, "cuisines": string[]|null, "ingredients": [ { "name": string, "quantity": number|null, "unit": string, "category": string|null } ], "instructions": string[] }, "confidence"?: number, "warnings"?: string[] } ], "warnings"?: string[] } OR { "error": "not_food" }',
      "Rules:",
      "- Extract 1..5 distinct recipes/dishes if they are present.",
      `- ingredients must be 1..${maxIngredients} items; infer missing details if needed (best-effort).`,
      "- Each ingredient.name must be a generic ingredient (no brand names).",
      "- unit must never be null.",
      "- instructions can be 0..15 steps; if not available, return an empty array.",
      '- If the image is not recipe-related at all, return { "error": "not_food" }.',
    ].join("\n");

    const parsedRecipeOnly = await callGeminiVisionParsedJson({
      endpoint,
      mimeType,
      imageBase64,
      systemInstruction: recipeOnlyInstruction,
      userPrompt: userNote ? `Extract recipes from this image.\n\nUser note (optional):\n${userNote}` : "Extract recipes from this image.",
      timeoutMs: 25_000,
    });

    if (isNotFoodError(parsedRecipeOnly)) {
      const error = new AiValidationError("No food or recipe found in that photo.");
      (error as any).aiScanReason = "not_food";
      throw error;
    }

    const recipeItems = extractRecipeItems(parsedRecipeOnly, maxIngredients, input.imageSize);
    if (recipeItems.length === 0) {
      const error = new AiValidationError("AI response did not include any usable recipes.");
      (error as any).aiScanReason = "not_food";
      throw error;
    }

    const warnings = normalizeWarnings((parsedRecipeOnly as any)?.warnings);
    return {
      kind: "recipes",
      meal: recipeItems[0].recipe,
      recipes: recipeItems,
      ...(warnings.length ? { warnings } : null),
    };
  }

  const primaryKind = typeof (parsedPrimary as any)?.kind === "string" ? String((parsedPrimary as any).kind).trim().toLowerCase() : "";
  const primaryIsRecipes = primaryKind === "recipes" || Array.isArray((parsedPrimary as any)?.recipes);
  if (primaryIsRecipes) {
    const recipeItems = extractRecipeItems(parsedPrimary, maxIngredients, input.imageSize);
    if (recipeItems.length === 0) {
      const error = new AiValidationError("AI response did not include any usable recipes.");
      (error as any).aiScanReason = "not_food";
      throw error;
    }
    const warnings = normalizeWarnings((parsedPrimary as any)?.warnings);
    return {
      kind: "recipes",
      meal: recipeItems[0].recipe,
      recipes: recipeItems,
      ...(warnings.length ? { warnings } : null),
    };
  }

  const region = extractRegion(parsedPrimary, input.imageSize);
  const confidence = normalizeConfidence((parsedPrimary as any)?.confidence);
  const candidates = extractCandidates(parsedPrimary);
  const detections = extractDetections(parsedPrimary, input.imageSize);

  const meal = validateGeneratedMeal(parsedPrimary, maxIngredients);
  return { kind: "meal", meal, region, confidence, candidates, detections };
}
