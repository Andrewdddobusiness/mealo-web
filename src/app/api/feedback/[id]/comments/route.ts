import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { ensureDbUser } from '@/lib/ensureDbUser';
import { isBodyTooLarge, stripControlChars } from '@/lib/validation';
import { db } from '../../../../../db';

const FEEDBACK_COMMENT_WINDOW_MS = 60 * 60 * 1000;
const FEEDBACK_COMMENT_LIMIT = 30;

const FEEDBACK_ADMIN_USER_IDS = new Set(
  (process.env.FEEDBACK_ADMIN_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function isFeedbackAdmin(userId: string): boolean {
  return FEEDBACK_ADMIN_USER_IDS.has(userId);
}

function parseIntWithDefault(value: string | null, defaultValue: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function coerceDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function formatRetryAfter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'a bit';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.ceil(seconds / 3600)}h`;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }
    const database = db;

    const { id: submissionId } = await params;
    if (!submissionId) {
      return new NextResponse('Missing id', { status: 400 });
    }

    const url = new URL(req.url);
    const limit = clampInt(parseIntWithDefault(url.searchParams.get('limit'), 50), 1, 100);
    const offset = clampInt(parseIntWithDefault(url.searchParams.get('offset'), 0), 0, 10_000);

    const result = await database.execute(sql`
      SELECT
        c.id,
        c.submission_id AS "submissionId",
        c.body,
        c.created_at AS "createdAt",
        u.id AS "authorId",
        u.name AS "authorName",
        u.avatar AS "authorAvatarUrl"
      FROM feedback_comments c
      INNER JOIN users u ON u.id = c.user_id
      WHERE c.submission_id = ${submissionId}
      ORDER BY c.created_at ASC
      LIMIT ${limit}
      OFFSET ${offset};
    `);

    return NextResponse.json(result.rows ?? []);
  } catch (error) {
    console.error('[FEEDBACK_COMMENTS_GET]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }
    const database = db;

    const { id: submissionId } = await params;
    if (!submissionId) {
      return new NextResponse('Missing id', { status: 400 });
    }

    if (isBodyTooLarge(req, 25_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    if (!isFeedbackAdmin(userId)) {
      const since = new Date(Date.now() - FEEDBACK_COMMENT_WINDOW_MS);
      const usageResult = await database.execute(sql`
        SELECT
          COUNT(*)::int AS "count",
          MIN(created_at) AS "oldest"
        FROM feedback_comments
        WHERE user_id = ${userId}
          AND created_at >= ${since};
      `);

      const usage = usageResult.rows?.[0] as { count?: unknown; oldest?: unknown } | undefined;
      const used = typeof usage?.count === 'number' && Number.isFinite(usage.count) ? usage.count : Number(usage?.count ?? 0);
      if (used >= FEEDBACK_COMMENT_LIMIT) {
        const oldest = coerceDate(usage?.oldest);
        const resetAtMs = oldest ? oldest.getTime() + FEEDBACK_COMMENT_WINDOW_MS : Date.now() + FEEDBACK_COMMENT_WINDOW_MS;
        const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
        const res = new NextResponse(
          `Too many comments. You can post up to ${FEEDBACK_COMMENT_LIMIT} per hour. Try again in ${formatRetryAfter(retryAfterSeconds)}.`,
          { status: 429 },
        );
        res.headers.set('retry-after', String(retryAfterSeconds));
        return res;
      }
    }

    const bodyJson = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const body = typeof bodyJson.body === 'string' ? stripControlChars(bodyJson.body).trim() : '';

    if (!body || body.length > 2000) {
      return new NextResponse('Comment is required (max 2000 chars)', { status: 400 });
    }

    const dbUser = await ensureDbUser(userId);

    const id = uuidv4();
    const now = new Date();

    await database.execute(sql`
      WITH inserted AS (
        INSERT INTO feedback_comments (
          id,
          submission_id,
          user_id,
          body,
          created_at
        )
        VALUES (
          ${id},
          ${submissionId},
          ${userId},
          ${body},
          ${now}
        )
        RETURNING 1
      )
      UPDATE feedback_submissions
      SET updated_at = ${now}
      WHERE id = ${submissionId};
    `);

    return NextResponse.json({
      id,
      submissionId,
      body,
      createdAt: now,
      authorId: dbUser.id,
      authorName: dbUser.name,
      authorAvatarUrl: dbUser.avatar,
    });
  } catch (error) {
    console.error('[FEEDBACK_COMMENTS_POST]', error);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '23503') {
      return new NextResponse('Not found', { status: 404 });
    }
    return new NextResponse('Internal Error', { status: 500 });
  }
}
