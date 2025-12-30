import { sql, type SQL } from 'drizzle-orm';
import { normalizeTitleCase } from './normalizeMeal';

type IngredientUsageRow = {
  name: string;
  nameNormalized: string;
  category: string | null;
};

function normalizeNameForLookup(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function toIngredientUsageRows(input: unknown): IngredientUsageRow[] {
  if (!Array.isArray(input)) return [];

  const byNormalized = new Map<string, IngredientUsageRow>();

  for (const raw of input) {
    const name =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && typeof (raw as any).name === 'string'
          ? String((raw as any).name)
          : '';

    const normalized = normalizeNameForLookup(name);
    if (!normalized) continue;

    const category =
      raw && typeof raw === 'object' && typeof (raw as any).category === 'string'
        ? String((raw as any).category).trim()
        : '';

    const existing = byNormalized.get(normalized);
    byNormalized.set(normalized, {
      name: normalizeTitleCase(name),
      nameNormalized: normalized,
      category: category ? category : existing?.category ?? null,
    });
  }

  return Array.from(byNormalized.values());
}

export async function recordIngredientUsage(
  db: { execute: (query: SQL) => Promise<unknown> },
  userId: string,
  ingredients: unknown,
) {
  const rows = toIngredientUsageRows(ingredients);
  if (rows.length === 0) return;

  const values = rows.map((row) => sql`(${row.name}, ${row.nameNormalized}, ${row.category})`);
  const valuesSql = sql.join(values, sql`, `);

  await db.execute(sql`
    WITH incoming(name, name_normalized, category) AS (
      VALUES ${valuesSql}
    ),
    user_upsert AS (
      INSERT INTO ingredients (
        id,
        name,
        name_normalized,
        category,
        is_global,
        created_by,
        use_count,
        last_used_at,
        created_at,
        updated_at
      )
      SELECT
        'ing_user_' || md5(${userId} || ':' || name_normalized),
        name,
        name_normalized,
        category,
        false,
        ${userId},
        1,
        now(),
        now(),
        now()
      FROM incoming
      ON CONFLICT (created_by, name_normalized) WHERE (is_global = false)
      DO UPDATE SET
        name = EXCLUDED.name,
        category = COALESCE(EXCLUDED.category, ingredients.category),
        use_count = ingredients.use_count + 1,
        last_used_at = now(),
        updated_at = now()
      RETURNING 1
    ),
    global_update AS (
      UPDATE ingredients g
      SET
        name = CASE
          WHEN g.name = lower(g.name) OR g.name = initcap(g.name_normalized) THEN i.name
          ELSE g.name
        END,
        category = COALESCE(g.category, i.category),
        use_count = g.use_count + 1,
        last_used_at = now(),
        updated_at = now()
      FROM incoming i
      WHERE g.is_global = true
        AND g.name_normalized = i.name_normalized
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM user_upsert) AS user_upserts,
           (SELECT count(*) FROM global_update) AS global_updates;
  `);
}
