export function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

function isAllCapsWord(word: string): boolean {
  return /^[^a-z]*[A-Z][^a-z]*$/.test(word);
}

function titleCaseFragment(fragment: string): string {
  const clean = fragment.toLowerCase();
  if (!clean) return clean;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function titleCaseToken(token: string): string {
  const clean = token.trim();
  if (!clean) return '';

  // Keep short all-caps tokens as-is (e.g. BBQ, API).
  if (isAllCapsWord(clean) && clean.length <= 4) return clean;

  // Hyphenated words: "stir-fry" -> "Stir-Fry"
  const hyphenParts = clean.split('-').map((part) => {
    // Apostrophes: "o'connor" -> "O'Connor"
    return part
      .split("'")
      .map((p) => titleCaseFragment(p))
      .join("'");
  });
  return hyphenParts.join('-');
}

export function normalizeTitleCase(input: string): string {
  const text = normalizeWhitespace(input);
  if (!text) return '';
  return text
    .split(' ')
    .map((token) => titleCaseToken(token))
    .filter(Boolean)
    .join(' ');
}

export function normalizeCuisine(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const value = normalizeWhitespace(input);
  return value ? normalizeTitleCase(value) : undefined;
}

export function normalizeMealName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const value = normalizeWhitespace(input);
  return value ? normalizeTitleCase(value) : undefined;
}

export function normalizeIngredients(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((raw) => {
    if (typeof raw === 'string') {
      return normalizeTitleCase(raw);
    }
    if (!raw || typeof raw !== 'object') return raw;
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? normalizeTitleCase(obj.name) : obj.name;
    return { ...obj, name };
  });
}

