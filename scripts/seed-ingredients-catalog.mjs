#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

function normalizeWhitespace(value) {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeNameForLookup(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function isAllCapsWord(word) {
  return /^[^a-z]*[A-Z][^a-z]*$/.test(word);
}

function titleCaseFragment(fragment) {
  const clean = fragment.toLowerCase();
  if (!clean) return clean;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function titleCaseToken(token) {
  const clean = token.trim();
  if (!clean) return '';

  if (isAllCapsWord(clean) && clean.length <= 4) return clean;

  const hyphenParts = clean.split('-').map((part) =>
    part
      .split("'")
      .map((p) => titleCaseFragment(p))
      .join("'"),
  );
  return hyphenParts.join('-');
}

function toTitleCase(input) {
  const text = normalizeWhitespace(input);
  if (!text) return '';
  return text
    .split(' ')
    .map((token) => titleCaseToken(token))
    .filter(Boolean)
    .join(' ');
}

const CATEGORY_BY_GROUP = {
  vegetables: 'Produce',
  fruits: 'Produce',
  herbs: 'Produce',
  spices: 'Spices & Seasonings',
  grains_and_starches: 'Grains & Pasta',
  meat: 'Meat & Seafood',
  poultry: 'Meat & Seafood',
  seafood: 'Meat & Seafood',
  dairy_and_eggs: 'Dairy',
  legumes_and_plant_protein: 'Pantry',
  nuts_and_seeds: 'Pantry',
  oils_and_fats: 'Pantry',
  condiments_and_sauces: 'Pantry',
  stocks_and_broths: 'Pantry',
  baking_and_sweeteners: 'Pantry',
  beverages: 'Pantry',
  snacks: 'Pantry',
  placeholders: null,
};

function mapGroupToCategory(groupId) {
  if (Object.prototype.hasOwnProperty.call(CATEGORY_BY_GROUP, groupId)) {
    return CATEGORY_BY_GROUP[groupId];
  }
  return toTitleCase(groupId.replace(/[_-]+/g, ' '));
}

function parseCsv(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function printUsage() {
  // Keep this short; script defaults to dry-run.
  console.log(`Seed global ingredient suggestions from the icon catalogue.

Usage:
  node scripts/seed-ingredients-catalog.mjs [--apply]

Options:
  --apply                Execute DB upsert (default is dry-run)
  --source <path>        Path to ingredients.json (defaults to icon generator list)
  --groups <a,b,c>       Only include these groups
  --exclude <a,b,c>      Exclude these groups (default excludes placeholders)
  --preview <n>          Print the first N normalized items (default 20)
  -h, --help             Show this help

Env:
  DATABASE_URL           Neon/Postgres connection string (or set in .env.local)
`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    source: null,
    groups: null,
    exclude: null,
    preview: 20,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--source') {
      args.source = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === '--groups') {
      args.groups = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === '--exclude') {
      args.exclude = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (arg === '--preview') {
      args.preview = Number(argv[i + 1] ?? args.preview);
      i++;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

async function loadCatalogue(sourcePath) {
  const raw = await fs.readFile(sourcePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (Array.isArray(parsed)) {
    return { groups: { all: parsed }, rawGroupCount: 1 };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ingredients.json must be a JSON array or an object mapping group names to arrays.');
  }

  const entries = Object.entries(parsed);
  const groups = {};
  for (const [groupId, list] of entries) {
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
      throw new Error(`ingredients.json group "${groupId}" must be an array of strings.`);
    }
    groups[groupId] = list;
  }

  return { groups, rawGroupCount: entries.length };
}

function buildSeedRows(groups, opts) {
  const includeGroups = opts.groups ? new Set(parseCsv(opts.groups)) : null;
  const excludedGroups = new Set(['placeholders', ...parseCsv(opts.exclude)]);

  const rowsByNormalized = new Map();
  const groupStats = new Map();
  let rawCount = 0;

  for (const [groupId, list] of Object.entries(groups)) {
    if (includeGroups && !includeGroups.has(groupId)) continue;
    if (excludedGroups.has(groupId)) continue;

    const category = mapGroupToCategory(groupId);
    groupStats.set(groupId, (groupStats.get(groupId) ?? 0) + list.length);

    for (const rawName of list) {
      rawCount++;
      const normalized = normalizeNameForLookup(String(rawName ?? ''));
      if (!normalized) continue;

      const existing = rowsByNormalized.get(normalized);
      if (existing) {
        if (!existing.category && category) existing.category = category;
        continue;
      }

      rowsByNormalized.set(normalized, {
        name: toTitleCase(rawName),
        nameNormalized: normalized,
        category: category ?? null,
      });
    }
  }

  const rows = Array.from(rowsByNormalized.values()).sort((a, b) =>
    a.nameNormalized.localeCompare(b.nameNormalized),
  );

  const categoryCounts = rows.reduce((acc, row) => {
    const key = row.category ?? 'Uncategorized';
    acc.set(key, (acc.get(key) ?? 0) + 1);
    return acc;
  }, new Map());

  return { rows, rawCount, groupStats, categoryCounts, excludedGroups, includeGroups };
}

async function upsertGlobalIngredients(db, rows) {
  if (rows.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0 };
  }

  const values = rows.map((row) => sql`(${row.name}, ${row.nameNormalized}, ${row.category})`);
  const valuesSql = sql.join(values, sql`, `);

  const result = await db.execute(sql`
    WITH incoming(name, name_normalized, category) AS (
      VALUES ${valuesSql}
    ),
    inserted AS (
      INSERT INTO public.ingredients (
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
        'ing_global_' || md5(name_normalized),
        name,
        name_normalized,
        category,
        true,
        NULL,
        0,
        NULL,
        now(),
        now()
      FROM incoming
      ON CONFLICT (name_normalized) WHERE (is_global = true)
      DO NOTHING
      RETURNING 1
    ),
    updated AS (
      UPDATE public.ingredients AS ing
      SET
        name = CASE
          WHEN ing.name = lower(ing.name) OR ing.name = initcap(ing.name_normalized) THEN incoming.name
          ELSE ing.name
        END,
        category = COALESCE(NULLIF(trim(ing.category), ''), incoming.category),
        updated_at = now()
      FROM incoming
      WHERE ing.is_global = true
        AND ing.name_normalized = incoming.name_normalized
        AND (
          (NULLIF(trim(ing.category), '') IS NULL AND incoming.category IS NOT NULL)
          OR (
            (ing.name = lower(ing.name) OR ing.name = initcap(ing.name_normalized))
            AND ing.name IS DISTINCT FROM incoming.name
          )
        )
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*) FROM inserted)::int AS inserted,
      (SELECT COUNT(*) FROM updated)::int AS updated;
  `);

  const row = Array.isArray(result.rows) ? result.rows[0] : null;
  const inserted = Number(row?.inserted ?? 0);
  const updated = Number(row?.updated ?? 0);
  return {
    inserted,
    updated,
    unchanged: Math.max(0, rows.length - inserted - updated),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const __filename = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(__filename);
  const projectRoot = path.resolve(scriptDir, '..');

  dotenv.config({ path: path.join(projectRoot, '.env.local') });

  const defaultSource = path.resolve(
    projectRoot,
    '..',
    '..',
    'icon-gen',
    'icon-gen',
    'ingredient-icon-generator',
    'ingredients.json',
  );
  const sourcePath = path.resolve(projectRoot, args.source ?? defaultSource);

  const { groups, rawGroupCount } = await loadCatalogue(sourcePath);
  const { rows, rawCount, groupStats, categoryCounts } = buildSeedRows(groups, args);

  console.log(`Source: ${sourcePath}`);
  console.log(`Groups in file: ${rawGroupCount}`);
  console.log(`Items processed: ${rawCount}`);
  console.log(`Unique normalized: ${rows.length}`);
  console.log('');

  const categoryLines = Array.from(categoryCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `  - ${category}: ${count}`);
  console.log('By category:');
  console.log(categoryLines.join('\n') || '  (none)');
  console.log('');

  const groupLines = Array.from(groupStats.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([groupId, count]) => `  - ${groupId}: ${count}`);
  console.log('By group:');
  console.log(groupLines.join('\n') || '  (none)');
  console.log('');

  const previewCount = Number.isFinite(args.preview) ? Math.max(0, Math.floor(args.preview)) : 0;
  if (previewCount > 0) {
    console.log(`Preview (first ${Math.min(previewCount, rows.length)}):`);
    for (const row of rows.slice(0, previewCount)) {
      console.log(`  - ${row.name} (${row.category ?? 'Uncategorized'})`);
    }
    console.log('');
  }

  if (!args.apply) {
    console.log('Dry run only (no DB writes). Re-run with --apply to upsert into public.ingredients.');
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL. Set it (or add it to mealo-web/mealo-web/.env.local).');
  }

  const db = drizzle(neon(databaseUrl));
  const { inserted, updated, unchanged } = await upsertGlobalIngredients(db, rows);
  console.log(`Done. Inserted: ${inserted}, updated: ${updated}, unchanged: ${unchanged}`);
}

await main();
