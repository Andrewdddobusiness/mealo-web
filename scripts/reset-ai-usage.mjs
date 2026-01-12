#!/usr/bin/env node
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

function printUsage() {
  console.log(`Reset AI usage counters (ai_usage table).

Usage:
  node scripts/reset-ai-usage.mjs [--apply] [--period YYYY-MM] [--all-periods]

Options:
  --apply         Execute the delete (default is dry-run)
  --period        Period key to reset (default current UTC month)
  --all-periods   Delete ALL ai_usage rows (ignores --period)
  -h, --help      Show this help

Env:
  DATABASE_URL    Postgres connection string (or set in .env.local)
`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    period: null,
    allPeriods: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--period') {
      args.period = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--all-periods') {
      args.allPeriods = true;
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

function getCurrentUtcPeriodKey(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function parsePeriodKey(value) {
  const period = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error(`Invalid period "${period}". Expected format YYYY-MM.`);
  }
  return period;
}

function safeDbLabel(databaseUrl) {
  try {
    const u = new URL(databaseUrl);
    const host = u.hostname || '(unknown-host)';
    const dbName = (u.pathname || '').replace(/^\//, '') || '(unknown-db)';
    return `${host}/${dbName}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

function getRowCount(result) {
  if (!result || typeof result !== 'object') return null;
  const rowCount = result.rowCount;
  if (typeof rowCount === 'number' && Number.isFinite(rowCount)) return rowCount;
  return null;
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

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL. Set it (or add it to mealo-web/mealo-web/.env.local).');
  }

  const db = drizzle(neon(databaseUrl));
  console.log(`Target DB: ${safeDbLabel(databaseUrl)}`);

  if (args.allPeriods) {
    const countRes = await db.execute(sql`SELECT COUNT(*)::int AS count FROM ai_usage;`);
    const count = Number((countRes.rows?.[0] ?? {}).count ?? 0);
    console.log(`Rows matching: ${count} (ALL periods, ALL users)`);

    if (!args.apply) {
      console.log('Dry run only (no DB writes). Re-run with --apply to delete these rows.');
      return;
    }

    const delRes = await db.execute(sql`DELETE FROM ai_usage;`);
    console.log(`Deleted rows: ${getRowCount(delRes) ?? 'unknown'}`);
    return;
  }

  const period = parsePeriodKey(args.period ?? getCurrentUtcPeriodKey());
  const countRes = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ai_usage
    WHERE period = ${period};
  `);
  const count = Number((countRes.rows?.[0] ?? {}).count ?? 0);

  console.log(`Period: ${period}`);
  console.log(`Rows matching: ${count} (ALL users)`);

  if (!args.apply) {
    console.log('Dry run only (no DB writes). Re-run with --apply to delete these rows.');
    return;
  }

  const delRes = await db.execute(sql`
    DELETE FROM ai_usage
    WHERE period = ${period};
  `);

  console.log(`Deleted rows: ${getRowCount(delRes) ?? 'unknown'}`);
}

await main();
