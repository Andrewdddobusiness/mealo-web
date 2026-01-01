import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { ensureDbUser } from '@/lib/ensureDbUser';
import { db } from '../../../../../db';

function parseIntWithDefault(value: string | null, defaultValue: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

    const bodyJson = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const body = typeof bodyJson.body === 'string' ? bodyJson.body.trim() : '';

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

