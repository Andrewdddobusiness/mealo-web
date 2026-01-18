export function stripControlChars(value: string): string {
  // Strip ASCII control chars plus bidirectional formatting characters that can be used for UI/log spoofing.
  // See: https://trojansource.codes/ (Bidi controls) — we remove only the formatting marks, not any language characters.
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function isUuid(value: string): boolean {
  // UUID v1-v5 (case-insensitive).
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validateUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isUuid(trimmed) ? trimmed : null;
}

export const LEGACY_ID_MAX_LENGTH = 128;
export function validateLegacyId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > LEGACY_ID_MAX_LENGTH) return null;
  // Allow opaque-but-safe IDs (legacy mobile used "meal-<timestamp>-<rand>").
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function validateRecordId(value: unknown): string | null {
  return validateUuid(value) ?? validateLegacyId(value);
}

export const HOUSEHOLD_NAME_MAX_LENGTH = 30;
export function validateHouseholdName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = normalizeWhitespace(stripControlChars(value));
  if (cleaned.length < 2) return null;
  if (cleaned.length > HOUSEHOLD_NAME_MAX_LENGTH) return null;
  // Allow letters, marks, numbers, spaces, apostrophes, hyphens.
  if (!/^[\p{L}\p{M}\p{N}\s'-]+$/u.test(cleaned)) return null;
  return cleaned;
}

export const INVITE_TOKEN_MAX_LENGTH = 128;
export function validateInviteToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (token.length < 6) return null;
  if (token.length > INVITE_TOKEN_MAX_LENGTH) return null;
  // Current format is UUID, but keep the allowlist permissive for future opaque tokens.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return token;
}

export const MEAL_NAME_MAX_LENGTH = 60;
export function validateMealName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = normalizeWhitespace(stripControlChars(value));
  if (cleaned.length < 2) return null;
  if (cleaned.length > MEAL_NAME_MAX_LENGTH) return null;
  // Allow letters, marks, numbers, spaces, apostrophes, hyphens.
  if (!/^[\p{L}\p{M}\p{N}\s'-]+$/u.test(cleaned)) return null;
  return cleaned;
}

export const MEAL_DESCRIPTION_MAX_LENGTH = 280;
export function validateMealDescription(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') return undefined;
  const cleaned = stripControlChars(value).trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MEAL_DESCRIPTION_MAX_LENGTH);
}

export function validatePlanDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  // Ensure it parses to a valid date.
  const d = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return trimmed;
}

export function getContentLength(req: Request): number | null {
  const raw = req.headers.get('content-length');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function isBodyTooLarge(req: Request, maxBytes: number): boolean {
  const len = getContentLength(req);
  return typeof len === 'number' && len > maxBytes;
}

export function sanitizeStringArray(value: unknown, opts: { maxItems: number; maxItemLength: number }): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const cleaned = stripControlChars(raw).trim();
    if (!cleaned) continue;
    out.push(cleaned.slice(0, opts.maxItemLength));
    if (out.length >= opts.maxItems) break;
  }
  return out;
}

export function sanitizeJsonArray(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems);
}

export function sanitizeShoppingList(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;

  const MAX_ITEMS = 500;
  const out: Array<Record<string, unknown>> = [];

  for (const raw of value.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;

    const ingredientNameRaw = typeof obj.ingredientName === 'string' ? obj.ingredientName : '';
    const ingredientName = normalizeWhitespace(stripControlChars(ingredientNameRaw)).slice(0, 120);
    if (!ingredientName) continue;

    const idRaw = typeof obj.id === 'string' ? obj.id : '';
    const id = normalizeWhitespace(stripControlChars(idRaw)).slice(0, 120);
    if (!id) continue;

    const isChecked = typeof obj.isChecked === 'boolean' ? obj.isChecked : false;

    const unitRaw = typeof obj.unit === 'string' ? obj.unit : '';
    const unit = unitRaw ? normalizeWhitespace(stripControlChars(unitRaw)).slice(0, 24) : '';

    const categoryRaw = typeof obj.category === 'string' ? obj.category : '';
    const category = categoryRaw ? normalizeWhitespace(stripControlChars(categoryRaw)).slice(0, 40) : '';

    const totalQuantityRaw = obj.totalQuantity;
    const totalQuantity =
      typeof totalQuantityRaw === 'number' && Number.isFinite(totalQuantityRaw) ? totalQuantityRaw : undefined;

    const sourceMeals = sanitizeStringArray(obj.sourceMeals, { maxItems: 50, maxItemLength: 120 });

    const item: Record<string, unknown> = {
      id,
      ingredientName,
      isChecked,
      sourceMeals,
    };
    if (typeof totalQuantity === 'number') item.totalQuantity = totalQuantity;
    if (unit) item.unit = unit;
    if (category) item.category = category;

    out.push(item);
  }

  return out;
}
