#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

dotenv.config({ path: '.env.local' });

const DEFAULT_MAP_PATH = fileURLToPath(new URL('./data/global-meal-images.json', import.meta.url));

function printUsage() {
  console.log(`Seed image URLs for predefined (global) meals.

Usage:
  node scripts/seed-global-meal-images.mjs [--apply] [--strategy <map|unsplash|clear>]

Options:
  --apply     Write updates to the DB (default is dry-run)
  --strategy  How to choose images (default: map)
               - map: read from --map file (recommended)
               - unsplash: auto-pick per-recipe images via search
               - clear: remove all images (sets to NULL)
  --map       Path to image map JSON (default: scripts/data/global-meal-images.json)
  --base-url  When using map items with filenames, build image URLs from this base
  --write-map Write a map file (template for map, filled for unsplash)
  --force     Overwrite existing DB images
  --limit     Only process the first N meals
  -h, --help  Show this help

Env:
  DATABASE_URL   Neon/Postgres connection string (or set in .env.local)
`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    help: false,
    strategy: 'map',
    map: DEFAULT_MAP_PATH,
    baseUrl: null,
    writeMap: false,
    force: false,
    limit: null,
    unsplashPerPage: 15,
    unsplashQuerySuffix: 'food',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--strategy') {
      args.strategy = argv[i + 1] ?? args.strategy;
      i++;
      continue;
    }
    if (arg === '--map') {
      args.map = argv[i + 1] ?? args.map;
      i++;
      continue;
    }
    if (arg === '--base-url') {
      args.baseUrl = argv[i + 1] ?? args.baseUrl;
      i++;
      continue;
    }
    if (arg === '--write-map') {
      args.writeMap = true;
      continue;
    }
    if (arg === '--force') {
      args.force = true;
      continue;
    }
    if (arg === '--limit') {
      const raw = argv[i + 1];
      i++;
      if (!raw) continue;
      const parsed = Number(raw);
      args.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (arg === '--unsplash-per-page') {
      const raw = argv[i + 1];
      i++;
      if (!raw) continue;
      const parsed = Number(raw);
      args.unsplashPerPage = Number.isFinite(parsed) && parsed > 0 ? parsed : args.unsplashPerPage;
      continue;
    }
    if (arg === '--unsplash-query-suffix') {
      args.unsplashQuerySuffix = argv[i + 1] ?? args.unsplashQuerySuffix;
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

function keyify(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isBlank(value) {
  return String(value ?? '').trim().length === 0;
}

function normalizeMealName(value) {
  return keyify(value);
}

function tokenizeMealName(value) {
  const base = normalizeMealName(value).split(' ').filter(Boolean);
  const tokens = new Set(base);
  // Common spelling variants
  if (tokens.has('omelette')) tokens.add('omelet');
  if (tokens.has('omelet')) tokens.add('omelette');
  if (tokens.has('spaghetti')) tokens.add('pasta');
  return tokens;
}

function scoreUnsplashResult(tokens, result) {
  const parts = [];
  if (result && typeof result === 'object') {
    if (typeof result.alt_description === 'string') parts.push(result.alt_description);
    if (typeof result.description === 'string') parts.push(result.description);
    if (typeof result.slug === 'string') parts.push(result.slug);
    const tags = Array.isArray(result.tags) ? result.tags : [];
    for (const tag of tags) {
      if (tag && typeof tag === 'object' && typeof tag.title === 'string') parts.push(tag.title);
    }
  }
  const haystack = keyify(parts.join(' '));
  if (!haystack) return 0;
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function transformUnsplashUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    url.searchParams.set('auto', 'format');
    url.searchParams.set('fit', 'crop');
    url.searchParams.set('w', '1200');
    url.searchParams.set('q', '80');
    return url.toString();
  } catch {
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}auto=format&fit=crop&w=1200&q=80`;
  }
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function mapItemsToLookup(mapJson) {
  const byId = new Map();
  const byName = new Map();

  if (!mapJson || typeof mapJson !== 'object') return { byId, byName };

  const baseUrl = typeof mapJson.baseUrl === 'string' && mapJson.baseUrl.trim() ? mapJson.baseUrl.trim() : null;

  if (mapJson.byName && typeof mapJson.byName === 'object' && !Array.isArray(mapJson.byName)) {
    for (const [name, value] of Object.entries(mapJson.byName)) {
      if (typeof value === 'string' && !isBlank(value)) byName.set(normalizeMealName(name), value.trim());
      if (value && typeof value === 'object' && typeof value.image === 'string' && !isBlank(value.image)) {
        byName.set(normalizeMealName(name), value.image.trim());
      }
    }
  }

  if (Array.isArray(mapJson.items)) {
    for (const item of mapJson.items) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id : null;
      const name = typeof item.name === 'string' ? item.name : null;
      const image = typeof item.image === 'string' ? item.image.trim() : '';
      const filename = typeof item.filename === 'string' ? item.filename.trim() : '';
      const joinUrl = (base, file) => {
        const left = String(base).replace(/\/+$/, '');
        const right = String(file).replace(/^\/+/, '');
        return `${left}/${right}`;
      };
      const effectiveImage = !isBlank(image)
        ? image
        : baseUrl && filename
          ? joinUrl(baseUrl, filename)
          : '';
      if (id && !isBlank(effectiveImage)) byId.set(id, effectiveImage);
      if (name && !isBlank(effectiveImage)) byName.set(normalizeMealName(name), effectiveImage);
    }
  }

  if (mapJson.byId && typeof mapJson.byId === 'object' && !Array.isArray(mapJson.byId)) {
    for (const [id, value] of Object.entries(mapJson.byId)) {
      if (typeof value === 'string' && !isBlank(value)) byId.set(id, value.trim());
      if (value && typeof value === 'object' && typeof value.image === 'string' && !isBlank(value.image)) {
        byId.set(id, value.image.trim());
      }
    }
  }

  return { byId, byName };
}

function buildMapTemplate(rows) {
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      image: row.image ?? '',
    })),
  };
}

async function pickUnsplashImageForMeal(name, opts) {
  const suffix = typeof opts.querySuffix === 'string' ? opts.querySuffix.trim() : '';
  const query = suffix ? `${name} ${suffix}` : name;
  const perPage = typeof opts.perPage === 'number' ? opts.perPage : 15;

  const url = new URL('https://unsplash.com/napi/search/photos');
  url.searchParams.set('query', query);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('orientation', 'squarish');

  const response = await fetch(url.toString(), {
    headers: {
      accept: 'application/json',
      'user-agent': 'mealo-seed-script',
    },
  });
  if (!response.ok) {
    throw new Error(`Unsplash search failed (${response.status}) for query "${query}"`);
  }

  const body = await response.json();
  const results = Array.isArray(body?.results) ? body.results : [];
  if (results.length === 0) return null;

  const tokens = tokenizeMealName(name);
  let best = results[0];
  let bestScore = scoreUnsplashResult(tokens, best);
  let bestLikes = typeof best?.likes === 'number' ? best.likes : 0;

  for (const candidate of results.slice(1)) {
    const score = scoreUnsplashResult(tokens, candidate);
    const likes = typeof candidate?.likes === 'number' ? candidate.likes : 0;
    if (score > bestScore || (score === bestScore && likes > bestLikes)) {
      best = candidate;
      bestScore = score;
      bestLikes = likes;
    }
  }

  const rawUrl =
    typeof best?.urls?.raw === 'string'
      ? best.urls.raw
      : typeof best?.urls?.regular === 'string'
        ? best.urls.regular
        : '';
  const image = transformUnsplashUrl(rawUrl);
  if (!image) return null;

  return {
    image,
    source: {
      provider: 'unsplash',
      query,
      photoId: best?.id ?? null,
      photoUrl: typeof best?.links?.html === 'string' ? best.links.html : null,
      photographer: typeof best?.user?.name === 'string' ? best.user.name : null,
      photographerUrl: typeof best?.user?.links?.html === 'string' ? best.user.links.html : null,
      alt: typeof best?.alt_description === 'string' ? best.alt_description : null,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (set it in .env.local or your environment).');
  }

  const strategy = String(args.strategy ?? 'map').toLowerCase();
  if (!['map', 'unsplash', 'clear'].includes(strategy)) {
    throw new Error(`Unknown strategy: ${args.strategy}`);
  }

  const client = neon(databaseUrl);
  const db = drizzle(client);

  const result = await db.execute(
    sql`SELECT id, name, collection, cuisine, image FROM global_meals`,
  );
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const candidates = rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      collection: row.collection,
      cuisine: row.cuisine,
      image: row.image,
    }))
    .filter((row) => !isBlank(row.id));

  const limitedCandidates = args.limit ? candidates.slice(0, args.limit) : candidates;
  const updates = [];
  const nextMapItems = [];

  if (strategy === 'clear') {
    for (const row of limitedCandidates) {
      const shouldUpdate = args.force ? !isBlank(row.image) : !isBlank(row.image);
      if (!shouldUpdate) continue;
      updates.push({ ...row, nextImage: null, reason: 'clear' });
    }
  } else if (strategy === 'map') {
    const mapJson = await readJsonIfExists(args.map);
    if (!mapJson) {
      const template = buildMapTemplate(limitedCandidates);
      if (args.writeMap) {
        await fs.mkdir(new URL('./data', import.meta.url), { recursive: true });
        await fs.writeFile(args.map, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
        console.log(`Wrote map template to ${args.map}`);
      } else {
        console.log(`Image map not found at ${args.map}. Re-run with --write-map to generate a template.`);
      }
      return;
    }

    if (args.baseUrl && (!mapJson.baseUrl || typeof mapJson.baseUrl !== 'string')) {
      mapJson.baseUrl = args.baseUrl;
    }
    const lookup = mapItemsToLookup(mapJson);
    for (const row of limitedCandidates) {
      const mapped =
        lookup.byId.get(row.id) ??
        lookup.byName.get(normalizeMealName(row.name));
      if (!mapped || isBlank(mapped)) continue;

      const shouldUpdate = args.force ? mapped.trim() !== String(row.image ?? '').trim() : isBlank(row.image);
      if (!shouldUpdate) continue;

      updates.push({ ...row, nextImage: mapped.trim(), reason: 'map' });
    }
  } else if (strategy === 'unsplash') {
    for (const row of limitedCandidates) {
      if (!args.force && !isBlank(row.image)) continue;
      const name = String(row.name ?? '').trim();
      if (!name) continue;

      let picked = null;
      try {
        picked = await pickUnsplashImageForMeal(name, {
          perPage: args.unsplashPerPage,
          querySuffix: args.unsplashQuerySuffix,
        });
      } catch (error) {
        console.warn(`Failed to pick Unsplash image for "${name}":`, error?.message ?? error);
        continue;
      }
      if (!picked?.image) continue;

      const nextImage = picked.image;
      const shouldUpdate = args.force ? nextImage.trim() !== String(row.image ?? '').trim() : isBlank(row.image);
      if (!shouldUpdate) continue;

      updates.push({ ...row, nextImage, reason: 'unsplash', source: picked.source });
      nextMapItems.push({
        id: row.id,
        name,
        image: nextImage,
        source: picked.source,
      });
    }

    if (args.writeMap) {
      const byName = {};
      const sourcesByName = {};
      for (const item of nextMapItems) {
        if (!item?.name || !item?.image) continue;
        byName[item.name] = item.image;
        if (item.source) sourcesByName[item.name] = item.source;
      }
      const out = { generatedAt: new Date().toISOString(), strategy: 'unsplash', byName, sourcesByName };
      await fs.mkdir(new URL('./data', import.meta.url), { recursive: true });
      await fs.writeFile(args.map, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
      console.log(`Wrote image map to ${args.map}`);
    }
  }

  console.log(
    `Found ${candidates.length} global meals. Strategy=${strategy}. ${updates.length} updates.`,
  );

  const preview = updates.slice(0, 12);
  if (preview.length > 0) {
    console.log('\nPreview:');
    for (const row of preview) {
      const name = String(row.name ?? '').trim() || '(unnamed)';
      const collection = String(row.collection ?? '').trim() || '(no collection)';
      const nextImage = row.nextImage == null ? '(clear)' : row.nextImage;
      const note = row.reason ? ` (${row.reason})` : '';
      console.log(`- ${name} [${collection}] -> ${nextImage}${note}`);
      if (row.source?.photoUrl) {
        console.log(`  source: ${row.source.photoUrl}`);
      }
    }
  }

  if (!args.apply) {
    console.log('\nDry-run complete. Re-run with --apply to write changes.');
    return;
  }

  let applied = 0;
  for (const row of updates) {
    const res = row.nextImage == null
      ? await db.execute(sql`UPDATE global_meals SET image = NULL WHERE id = ${row.id}`)
      : await db.execute(sql`UPDATE global_meals SET image = ${row.nextImage} WHERE id = ${row.id}`);
    if (typeof res.rowCount === 'number') applied += res.rowCount;
    else applied += 1;
  }

  console.log(`\nApplied ${applied} updates.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
