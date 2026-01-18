#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Separator, checkbox, confirm, input, select } from '@inquirer/prompts';

dotenv.config({ path: '.env.local' });

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_MAP_PATH = path.join(PROJECT_DIR, 'scripts', 'data', 'global-meal-images.json');
const DEFAULT_OUT_DIR = path.join(PROJECT_DIR, 'public', 'global-meals');

function printUsage() {
  console.log(`Generate realistic images for predefined (global) meals using OpenAI.

Usage:
  node scripts/generate-global-meal-images.mjs [--apply]

Tip:
  Run without flags to use the interactive wizard.

Options:
  --apply         Call the OpenAI API and write image files (default is dry-run)
  --list          Print available images and exit
  --select        Interactive picker (when supported)
  --only <csv>    Only generate these meal names (comma-separated)
  --match <text>  Only generate meals whose name includes this text
  --range <spec>  Only generate by index (e.g. "1,3-5")
  --start <n>     1-based start index for batch runs
  --map <path>    JSON map file (default: scripts/data/global-meal-images.json)
  --out <dir>     Output folder (default: public/global-meals)
  --model <name>  Override model (default: OPENAI_IMAGE_MODEL or gpt-image-1)
  --size <WxH>    Image size (default: 1024x1024)
  --limit <n>     Only generate first N images
  --concurrency   Number of parallel generations (default: 1)
  --force         Regenerate even if the file already exists
  -h, --help      Show this help

Env:
  OPENAI_API_KEY       Required
  OPENAI_IMAGE_MODEL   Optional (e.g. gpt-image-1, dall-e-3)
`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    help: false,
    list: false,
    select: false,
    only: null,
    match: null,
    range: null,
    start: null,
    map: DEFAULT_MAP_PATH,
    out: DEFAULT_OUT_DIR,
    model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    size: '1024x1024',
    limit: null,
    concurrency: 1,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--list') {
      args.list = true;
      continue;
    }
    if (arg === '--select') {
      args.select = true;
      continue;
    }
    if (arg === '--only') {
      args.only = argv[i + 1] ?? args.only;
      i++;
      continue;
    }
    if (arg === '--match') {
      args.match = argv[i + 1] ?? args.match;
      i++;
      continue;
    }
    if (arg === '--range') {
      args.range = argv[i + 1] ?? args.range;
      i++;
      continue;
    }
    if (arg === '--start') {
      const raw = argv[i + 1];
      i++;
      const parsed = Number(raw);
      args.start = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (arg === '--map') {
      args.map = argv[i + 1] ?? args.map;
      i++;
      continue;
    }
    if (arg === '--out') {
      args.out = argv[i + 1] ?? args.out;
      i++;
      continue;
    }
    if (arg === '--model') {
      args.model = argv[i + 1] ?? args.model;
      i++;
      continue;
    }
    if (arg === '--size') {
      args.size = argv[i + 1] ?? args.size;
      i++;
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
    if (arg === '--concurrency') {
      const raw = argv[i + 1];
      i++;
      if (!raw) continue;
      const parsed = Number(raw);
      args.concurrency = Number.isFinite(parsed) && parsed > 0 ? Math.min(6, Math.floor(parsed)) : args.concurrency;
      continue;
    }
    if (arg === '--force') {
      args.force = true;
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

function isBlank(value) {
  return String(value ?? '').trim().length === 0;
}

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function ensurePngFilename(filename) {
  const clean = String(filename ?? '').trim();
  if (!clean) return '';
  if (clean.toLowerCase().endsWith('.png')) return clean;
  return `${clean.replace(/\.[a-z0-9]+$/i, '')}.png`;
}

function normalizePrompt(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseIndexRange(value, max) {
  if (!value) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  if (raw === '*' || raw.toLowerCase() === 'all') return Array.from({ length: max }, (_, i) => i + 1);

  const out = new Set();
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const idx = Number(part);
      if (idx >= 1 && idx <= max) out.add(idx);
      continue;
    }
    const match = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const lo = Math.max(1, Math.min(start, end));
    const hi = Math.min(max, Math.max(start, end));
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return Array.from(out).sort((a, b) => a - b);
}

function normalizeNameKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

function assertNoFilenameCollisions(items) {
  const seen = new Map();
  for (const item of items) {
    const key = normalizeNameKey(item.filename);
    const existing = seen.get(key);
    if (existing && existing !== item.name) {
      throw new Error(`Filename collision: "${item.filename}" is used by both "${existing}" and "${item.name}".`);
    }
    seen.set(key, item.name);
  }
}

function printItems(items) {
  items.forEach((item, idx) => {
    const i = String(idx + 1).padStart(2, ' ');
    console.log(`${i}. ${item.name} -> ${item.filename}`);
  });
}

function buildApiPrompt(item) {
  const base = normalizePrompt(item.prompt || item.name);
  // Reinforce "realistic" style in a consistent way without fighting the user's prompt.
  const suffix =
    ' Photorealistic food photography. Natural window light. No text. No watermark. No logos. Square composition.';
  if (!base) return '';
  if (base.toLowerCase().includes('photorealistic')) return base;
  return `${base}${suffix}`;
}

async function generateImageB64({ apiKey, model, prompt, size }) {
  const baseBody = {
    model,
    prompt,
    size,
    n: 1,
  };

  const shouldAskForB64 = String(model || '').toLowerCase().startsWith('dall-e');
  const bodyWithPreferredFormat = shouldAskForB64 ? { ...baseBody, response_format: 'b64_json' } : baseBody;

  const makeRequest = async (body) => {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`OpenAI image generation failed (${response.status}): ${text}`);
    return JSON.parse(text);
  };

  let json;
  try {
    json = await makeRequest(bodyWithPreferredFormat);
  } catch (error) {
    // Some models/endpoints reject `response_format` (e.g. gpt-image-1).
    const message = String(error?.message ?? '');
    if (shouldAskForB64 && message.includes("Unknown parameter: 'response_format'")) {
      json = await makeRequest(baseBody);
    } else {
      throw error;
    }
  }

  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 === 'string' && b64) return b64;

  const url = json?.data?.[0]?.url;
  if (typeof url === 'string' && url) {
    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      const errText = await imgRes.text().catch(() => '');
      throw new Error(`OpenAI image download failed (${imgRes.status}): ${errText}`);
    }
    const arrayBuffer = await imgRes.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  }

  throw new Error('OpenAI image generation returned no b64_json/url.');
}

async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      // eslint-disable-next-line no-await-in-loop
      await worker(next);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY || '';

  const mapPath = path.resolve(process.cwd(), args.map);
  const outDir = path.resolve(process.cwd(), args.out);
  const mapJson = await readJson(mapPath);
  const items = Array.isArray(mapJson?.items) ? mapJson.items : [];

  const normalized = items
    .map((item) => ({
      name: String(item?.name ?? '').trim(),
      filename: ensurePngFilename(item?.filename ?? ''),
      prompt: String(item?.prompt ?? '').trim(),
    }))
    .filter((item) => !isBlank(item.name) && !isBlank(item.filename));

  assertNoFilenameCollisions(normalized);

  if (normalized.length === 0) {
    console.log('No items found to generate.');
    return;
  }

  if (args.list) {
    printItems(normalized);
    return;
  }

  const shouldLaunchWizard =
    isInteractive() &&
    !args.apply &&
    !args.only &&
    !args.match &&
    !args.range &&
    !args.start &&
    !args.limit &&
    !args.select;

  if (shouldLaunchWizard) {
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Preview (dry-run, no cost)', value: 'preview' },
        { name: 'Generate images (calls OpenAI, costs money)', value: 'generate' },
        { name: 'List available meals', value: 'list' },
        new Separator(),
        { name: 'Exit', value: 'exit' },
      ],
    });

    if (action === 'exit') return;
    if (action === 'list') {
      printItems(normalized);
      return;
    }

    if (action === 'generate') {
      if (!apiKey) {
        console.log('OPENAI_API_KEY is not set. Add it to mealo-web/mealo-web/.env.local, then re-run this script.');
        return;
      }
      args.apply = true;
      args.force = await confirm({ message: 'Overwrite existing files if present?', default: false });
    } else {
      args.apply = false;
    }

    args.select = true;
  }

  let selected = [...normalized];

  // Non-interactive filters.
  if (args.only) {
    const wanted = new Set(parseCsv(args.only).map(normalizeNameKey));
    selected = selected.filter((item) => wanted.has(normalizeNameKey(item.name)));
  }

  if (args.match) {
    const needle = normalizeNameKey(args.match);
    selected = selected.filter((item) => normalizeNameKey(item.name).includes(needle));
  }

  if (args.range) {
    const indices = parseIndexRange(args.range, normalized.length);
    const byIndex = new Map(normalized.map((item, idx) => [idx + 1, item]));
    selected = indices.map((idx) => byIndex.get(idx)).filter(Boolean);
  }

  // Batch slicing.
  if (args.start) {
    const startIdx = Math.max(0, args.start - 1);
    selected = selected.slice(startIdx);
  }
  if (args.limit) {
    selected = selected.slice(0, args.limit);
  }

  // Interactive picker (when supported).
  if (
    selected.length === normalized.length &&
    (args.select || (isInteractive() && !args.only && !args.match && !args.range && !args.start))
  ) {
    const mode = await select({
      message: 'Pick what to generate',
      choices: [
        { name: 'All', value: 'all' },
        { name: 'Pick from list', value: 'list' },
        { name: 'Search by name', value: 'search' },
        { name: 'By index/range (e.g. 1,3-5)', value: 'range' },
        new Separator(),
        { name: 'Cancel', value: 'cancel' },
      ],
    });

    if (mode === 'cancel') return;

    if (mode === 'all') {
      selected = [...normalized];
    } else if (mode === 'list') {
      const pickedNames = await checkbox({
        message: 'Select meals to generate',
        choices: normalized.map((item) => ({ name: `${item.name} (${item.filename})`, value: item.name })),
        required: true,
      });
      const wanted = new Set(pickedNames.map(normalizeNameKey));
      selected = normalized.filter((item) => wanted.has(normalizeNameKey(item.name)));
    } else if (mode === 'search') {
      const term = await input({ message: 'Search text', default: '' });
      const needle = normalizeNameKey(term);
      const matches = normalized.filter((item) => normalizeNameKey(item.name).includes(needle));
      if (matches.length === 0) {
        console.log('No matches.');
        return;
      }
      const pickedNames = await checkbox({
        message: 'Select meals to generate',
        choices: matches.map((item) => ({ name: `${item.name} (${item.filename})`, value: item.name })),
        required: true,
      });
      const wanted = new Set(pickedNames.map(normalizeNameKey));
      selected = matches.filter((item) => wanted.has(normalizeNameKey(item.name)));
    } else if (mode === 'range') {
      const rawRange = await input({ message: 'Enter indices/range', default: '1-10' });
      const indices = parseIndexRange(rawRange, normalized.length);
      const byIndex = new Map(normalized.map((item, idx) => [idx + 1, item]));
      selected = indices.map((idx) => byIndex.get(idx)).filter(Boolean);
    }
  }

  if (selected.length === 0) {
    console.log('No images selected.');
    return;
  }

  if (args.apply && !apiKey) {
    throw new Error('OPENAI_API_KEY is not set. Add it to mealo-web/mealo-web/.env.local or export it in your shell.');
  }

  await fs.mkdir(outDir, { recursive: true });

  console.log(
    `Prepared ${selected.length} image(s). model=${args.model} size=${args.size} apply=${args.apply} force=${args.force} concurrency=${args.concurrency}`,
  );
  if (!args.apply) {
    console.log('Dry-run: no API calls will be made and no files will be written. Re-run with --apply to generate images.');
  }

  if (args.apply && isInteractive()) {
    const ok = await confirm({
      message: `Proceed to generate ${selected.length} image(s) now?`,
      default: false,
    });
    if (!ok) {
      console.log('Cancelled.');
      return;
    }
  }

  await runPool(selected, args.concurrency, async (item) => {
    const targetPath = path.join(outDir, item.filename);
    const exists = await fileExists(targetPath);
    if (exists && !args.force) {
      console.log(`- Skipping (exists): ${item.filename}`);
      return;
    }

    const prompt = buildApiPrompt(item);
    if (!prompt) {
      console.log(`- Skipping (missing prompt): ${item.name}`);
      return;
    }

    console.log(`- ${args.apply ? 'Generating' : 'Would generate'}: ${item.name} -> ${item.filename}`);
    if (!args.apply) return;

    const b64 = await generateImageB64({
      apiKey,
      model: args.model,
      prompt,
      size: args.size,
    });

    const buffer = Buffer.from(b64, 'base64');
    await fs.writeFile(targetPath, buffer);
  });

  console.log(`\nDone. Output folder: ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
