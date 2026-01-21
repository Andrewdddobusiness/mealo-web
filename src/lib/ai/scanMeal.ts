import {
  AiConfigError,
  AiProviderError,
  AiTimeoutError,
  AiValidationError,
  type GeneratedMeal,
  extractJsonObject,
  validateGeneratedMeal,
} from "./generateMeal";

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

function normalizeBbox(raw: unknown): ScanRegion["bbox"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const x =
    typeof obj.x === "number" && Number.isFinite(obj.x) ? obj.x : undefined;
  const y =
    typeof obj.y === "number" && Number.isFinite(obj.y) ? obj.y : undefined;
  const width =
    typeof obj.width === "number" && Number.isFinite(obj.width)
      ? obj.width
      : undefined;
  const height =
    typeof obj.height === "number" && Number.isFinite(obj.height)
      ? obj.height
      : undefined;
  if (x == null || y == null || width == null || height == null)
    return undefined;
  const pad = 0.04;
  const cw = clamp(width + pad * 2, 0.05, 1);
  const ch = clamp(height + pad * 2, 0.05, 1);
  const cx = clamp(x - pad, 0, 1 - cw);
  const cy = clamp(y - pad, 0, 1 - ch);
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

function normalizeDetection(raw: unknown): ScanDetection | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return null;
  const bbox = normalizeBbox(obj.bbox);
  if (!bbox) return null;
  const confidence = normalizeConfidence(obj.confidence);
  const out: ScanDetection = {
    name: name.slice(0, 80),
    bbox: bbox as { x: number; y: number; width: number; height: number },
  };
  if (confidence != null) out.confidence = confidence;
  return out;
}

function extractRegion(parsed: unknown): ScanRegion | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const regionRaw = (parsed as any).region;
  if (!regionRaw || typeof regionRaw !== "object") return undefined;
  const bbox = normalizeBbox((regionRaw as any).bbox);
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

function extractDetections(parsed: unknown): ScanDetection[] | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const raw = (parsed as any).detections;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ScanDetection[] = [];
  for (const item of raw) {
    const detection = normalizeDetection(item);
    if (!detection) continue;
    const key = detection.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(detection);
    if (out.length >= 6) break;
  }
  return out.length ? out : undefined;
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

export async function scanMealFromImage(input: {
  imageBase64: string;
  mimeType: string;
  maxIngredients?: number;
}): Promise<{
  meal: GeneratedMeal;
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

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const systemInstruction = [
    "You analyze an image for a meal planning app.",
    "The image may show: (a) a cooked meal, (b) meal ingredients, or (c) a recipe (text).",
    "Return ONLY valid JSON (no markdown, no code fences, no explanations).",
    "The JSON MUST be ONE of these shapes:",
    '- { "meal": { "name": string, "cuisines": string[]|null, "ingredients": [ { "name": string, "quantity": number|null, "unit": string, "category": string|null } ], "instructions": string[] }, "confidence"?: number, "candidates"?: [ { "name": string, "confidence"?: number } ], "region"?: { "bbox"?: { "x": number, "y": number, "width": number, "height": number } }, "detections": [ { "name": string, "confidence"?: number, "bbox": { "x": number, "y": number, "width": number, "height": number } } ] }',
    '- OR { "error": "not_food" }',
    "Rules:",
    '- If the image is NOT food/ingredients/recipe (e.g. electronics, people, pets, cleaning products, household objects), return { "error": "not_food" }.',
    "- Packaged food or beverages (including bottles/cans with drinks) count as food.",
    '- If uncertain whether it is food/recipe, prefer { "error": "not_food" } rather than guessing.',
    "- Otherwise, make a best-effort identification from the image.",
    `- ingredients must be 1..${maxIngredients} items`,
    "- Each ingredient.name must be a generic ingredient (no brand names).",
    "- Prefer including quantity + unit, but if unsure you may return null quantity.",
    "- unit must never be null; choose a reasonable unit (g, piece, tbsp, tsp, cup, ml, etc.).",
    "- category should be one of: Produce, Pantry, Meat, Dairy, Bakery, Other (or null).",
    "- instructions should be a short list of steps (0..15). If you cannot infer cooking steps from the image, return an empty array.",
    "- If the image contains a clear meal subject, include region.bbox as a best-effort bounding box around the FULL dish/drink/food item (normalized 0..1).",
    "- confidence is optional and should be 0..1 for the primary name.",
    "- candidates (optional) should be 0..3 alternative meal names (no brands), each with optional confidence 0..1.",
    '- IMPORTANT: The "detections" array is REQUIRED. Analyze the image and identify ALL distinct food items visible (1..6 items). For each food item, provide its name and a bounding box (normalized 0..1 coordinates) around the FULL item. Include confidence 0..1 if possible.',
    "- Each detection.bbox must tightly wrap the individual food item (e.g., if there are 3 dishes on a table, return 3 detections with separate bboxes).",
    '- Detection names should be specific (e.g., "Pad Thai", "Water Bottle", "Fried Rice" rather than just "Food").',
    "- If only a single food item is visible, the detections array should contain exactly 1 detection for that item.",
  ].join("\n");

  const userPrompt = [
    "If the image contains a meal/ingredients/recipe, return the meal name, main ingredients, and brief cooking instructions (if inferable).",
    'If it does not look food-related, return { "error": "not_food" }.',
  ].join("\n");

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
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
          responseMimeType: "application/json",
        },
      }),
    },
    25_000,
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
  const parsed = extractJsonObject(text);
  const region = extractRegion(parsed);
  const confidence = normalizeConfidence((parsed as any)?.confidence);
  const candidates = extractCandidates(parsed);
  const detections = extractDetections(parsed);
  const rootError =
    parsed && typeof parsed === "object"
      ? ((parsed as any).error ?? (parsed as any).meal?.error ?? undefined)
      : undefined;

  if (
    typeof rootError === "string" &&
    rootError.trim().toLowerCase() === "not_food"
  ) {
    const error = new AiValidationError("No food found in that photo.");
    (error as any).aiScanReason = "not_food";
    throw error;
  }

  const meal = validateGeneratedMeal(parsed, maxIngredients);
  return { meal, region, confidence, candidates, detections };
}
