import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

// Server-side DB client (null when not configured, e.g. local dev without env vars).
export const db: NeonHttpDatabase<typeof schema> | null = connectionString
  ? drizzle(neon(connectionString), { schema })
  : null;
