import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { ensureDbUser } from '@/lib/ensureDbUser';
import { db } from '../../../db';
import { feedbackSubmissions } from '../../../db/schema';

type FeedbackSort = 'top' | 'new';
type FeedbackType = 'feature' | 'bug';

const FEEDBACK_SUBMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const FEEDBACK_SUBMISSION_LIMIT = 5;

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

function isFeedbackType(value: unknown): value is FeedbackType {
  return value === 'feature' || value === 'bug';
}

function isFeedbackSort(value: unknown): value is FeedbackSort {
  return value === 'top' || value === 'new';
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

export async function GET(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }
    const database = db;

    const url = new URL(req.url);
    const sortRaw = url.searchParams.get('sort') ?? 'top';
    const typeRaw = url.searchParams.get('type');

    if (!isFeedbackSort(sortRaw)) {
      return new NextResponse('Invalid sort', { status: 400 });
    }

    const type = typeRaw == null ? null : typeRaw;
    if (type != null && !isFeedbackType(type)) {
      return new NextResponse('Invalid type', { status: 400 });
    }

    const limit = clampInt(parseIntWithDefault(url.searchParams.get('limit'), 20), 1, 50);
    const offset = clampInt(parseIntWithDefault(url.searchParams.get('offset'), 0), 0, 10_000);

    const typeFilter = type ? sql`AND s.type = ${type}` : sql``;
    const orderBy =
      sortRaw === 'top'
        ? sql`ORDER BY COALESCE(v.vote_count, 0) DESC, s.created_at DESC`
        : sql`ORDER BY s.created_at DESC`;

    const result = await database.execute(sql`
      WITH vote_counts AS (
        SELECT submission_id, COUNT(*)::int AS vote_count
        FROM feedback_votes
        GROUP BY submission_id
      ),
      comment_counts AS (
        SELECT submission_id, COUNT(*)::int AS comment_count
        FROM feedback_comments
        GROUP BY submission_id
      ),
      viewer_votes AS (
        SELECT submission_id, TRUE AS viewer_has_voted
        FROM feedback_votes
        WHERE user_id = ${userId}
      )
      SELECT
        s.id,
        s.title,
        s.description,
        s.type,
        s.status,
        s.created_at AS "createdAt",
        s.updated_at AS "updatedAt",
        u.id AS "authorId",
        u.name AS "authorName",
        u.avatar AS "authorAvatarUrl",
        COALESCE(v.vote_count, 0)::int AS "voteCount",
        COALESCE(c.comment_count, 0)::int AS "commentCount",
        COALESCE(vv.viewer_has_voted, FALSE) AS "viewerHasVoted"
      FROM feedback_submissions s
      INNER JOIN users u ON u.id = s.user_id
      LEFT JOIN vote_counts v ON v.submission_id = s.id
      LEFT JOIN comment_counts c ON c.submission_id = s.id
      LEFT JOIN viewer_votes vv ON vv.submission_id = s.id
      WHERE 1=1
      ${typeFilter}
      ${orderBy}
      LIMIT ${limit}
      OFFSET ${offset};
    `);

    return NextResponse.json(result.rows ?? []);
  } catch (error) {
    console.error('[FEEDBACK_GET]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }
    const database = db;

    if (!isFeedbackAdmin(userId)) {
      const since = new Date(Date.now() - FEEDBACK_SUBMISSION_WINDOW_MS);
      const usageResult = await database.execute(sql`
        SELECT
          COUNT(*)::int AS "count",
          MIN(created_at) AS "oldest"
        FROM feedback_submissions
        WHERE user_id = ${userId}
          AND created_at >= ${since};
      `);

      const usage = usageResult.rows?.[0] as { count?: unknown; oldest?: unknown } | undefined;
      const used = typeof usage?.count === 'number' && Number.isFinite(usage.count) ? usage.count : Number(usage?.count ?? 0);
      if (used >= FEEDBACK_SUBMISSION_LIMIT) {
        const oldest = coerceDate(usage?.oldest);
        const resetAtMs = oldest ? oldest.getTime() + FEEDBACK_SUBMISSION_WINDOW_MS : Date.now() + FEEDBACK_SUBMISSION_WINDOW_MS;
        const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
        const res = new NextResponse(
          `Too many feedback submissions. You can post up to ${FEEDBACK_SUBMISSION_LIMIT} every 24 hours. Try again in ${formatRetryAfter(retryAfterSeconds)}.`,
          { status: 429 },
        );
        res.headers.set('retry-after', String(retryAfterSeconds));
        return res;
      }
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const type = body.type;

    if (!title || title.length > 120) {
      return new NextResponse('Title is required (max 120 chars)', { status: 400 });
    }
    if (!description || description.length > 4000) {
      return new NextResponse('Description is required (max 4000 chars)', { status: 400 });
    }
    if (!isFeedbackType(type)) {
      return new NextResponse('Invalid type', { status: 400 });
    }

    const dbUser = await ensureDbUser(userId);

    const id = uuidv4();
    const now = new Date();

    const newSubmission: typeof feedbackSubmissions.$inferInsert = {
      id,
      userId,
      title,
      description,
      type,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };

    await database.insert(feedbackSubmissions).values(newSubmission);

    return NextResponse.json({
      id,
      title,
      description,
      type,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      authorId: dbUser.id,
      authorName: dbUser.name,
      authorAvatarUrl: dbUser.avatar,
      voteCount: 0,
      commentCount: 0,
      viewerHasVoted: false,
    });
  } catch (error) {
    console.error('[FEEDBACK_POST]', error);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '23503') {
      return new NextResponse('Missing required user record', { status: 409 });
    }
    return new NextResponse('Internal Error', { status: 500 });
  }
}
