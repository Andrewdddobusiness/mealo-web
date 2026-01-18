import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { stripControlChars } from '@/lib/validation';
import { db } from '../../../../db';

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 4000;

// Author editing rules (also used to compute viewer permissions)
const EDIT_WINDOW_MINUTES = 30;
const DELETE_WINDOW_MINUTES = 30;
const MAX_EDITS_PER_SUBMISSION = 1;

const FEEDBACK_ADMIN_USER_IDS = new Set(
  (process.env.FEEDBACK_ADMIN_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function isFeedbackAdmin(userId: string): boolean {
  return FEEDBACK_ADMIN_USER_IDS.has(userId);
}

function sanitizeText(value: unknown): string {
  return typeof value === 'string' ? stripControlChars(value).trim() : '';
}

function coerceDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function withinMinutes(then: Date | null, minutes: number, now: Date): boolean {
  if (!then) return false;
  const deltaMs = now.getTime() - then.getTime();
  return deltaMs >= 0 && deltaMs <= minutes * 60 * 1000;
}

function isFeedbackStatus(value: unknown): value is 'open' | 'planned' | 'in_progress' | 'done' {
  return value === 'open' || value === 'planned' || value === 'in_progress' || value === 'done';
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

    const { id } = await params;
    if (!id) {
      return new NextResponse('Missing id', { status: 400 });
    }

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
        COALESCE(s.edit_count, 0)::int AS "editCount",
        s.last_edited_at AS "lastEditedAt",
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
      WHERE s.id = ${id}
      LIMIT 1;
    `);

    const item = result.rows?.[0];
    if (!item) {
      return new NextResponse('Not found', { status: 404 });
    }

    const now = new Date();
    const createdAt = coerceDate((item as { createdAt?: unknown } | null)?.createdAt);
    const editCountRaw = (item as { editCount?: unknown } | null)?.editCount;
    const editCount = typeof editCountRaw === 'number' && Number.isFinite(editCountRaw) ? editCountRaw : Number(editCountRaw ?? 0);

    const viewerIsAdmin = isFeedbackAdmin(userId);
    const viewerIsAuthor = (item as { authorId?: unknown } | null)?.authorId === userId;
    const viewerCanEdit = viewerIsAuthor && withinMinutes(createdAt, EDIT_WINDOW_MINUTES, now) && editCount < MAX_EDITS_PER_SUBMISSION;
    const viewerCanDelete = viewerIsAuthor && withinMinutes(createdAt, DELETE_WINDOW_MINUTES, now);

    return NextResponse.json({
      ...item,
      viewerIsAdmin,
      viewerCanEdit,
      viewerCanDelete,
    });
  } catch (error) {
    console.error('[FEEDBACK_ID_GET]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }
    const database = db;

    const { id } = await params;
    if (!id) {
      return new NextResponse('Missing id', { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const wantsTitle = Object.prototype.hasOwnProperty.call(body, 'title');
    const wantsDescription = Object.prototype.hasOwnProperty.call(body, 'description');
    const wantsStatus = Object.prototype.hasOwnProperty.call(body, 'status');

    if (!wantsTitle && !wantsDescription && !wantsStatus) {
      return new NextResponse('No updates provided', { status: 400 });
    }

    const requestedTitle = wantsTitle ? sanitizeText(body.title) : undefined;
    const requestedDescription = wantsDescription ? sanitizeText(body.description) : undefined;
    const requestedStatus = wantsStatus ? sanitizeText(body.status) : undefined;

    const currentResult = await database.execute(sql`
      SELECT
        id,
        user_id AS "userId",
        title,
        description,
        status,
        COALESCE(edit_count, 0)::int AS "editCount",
        created_at AS "createdAt"
      FROM feedback_submissions
      WHERE id = ${id}
      LIMIT 1;
    `);

    const current = currentResult.rows?.[0] as
      | {
          userId?: unknown;
          title?: unknown;
          description?: unknown;
          status?: unknown;
          editCount?: unknown;
          createdAt?: unknown;
        }
      | undefined;
    if (!current) {
      return new NextResponse('Not found', { status: 404 });
    }

    const viewerIsAdmin = isFeedbackAdmin(userId);
    const viewerIsAuthor = current.userId === userId;

    const nextTitle = requestedTitle ?? String(current.title ?? '');
    const nextDescription = requestedDescription ?? String(current.description ?? '');
    const contentChanged = nextTitle !== String(current.title ?? '') || nextDescription !== String(current.description ?? '');

    const nextStatusRaw = requestedStatus ?? String(current.status ?? 'open');
    const statusChanged = requestedStatus != null && nextStatusRaw !== String(current.status ?? '');

    if (contentChanged) {
      if (!viewerIsAuthor) {
        return new NextResponse('Forbidden', { status: 403 });
      }

      if (!nextTitle || nextTitle.length > MAX_TITLE_LENGTH) {
        return new NextResponse(`Title is required (max ${MAX_TITLE_LENGTH} chars)`, { status: 400 });
      }
      if (!nextDescription || nextDescription.length > MAX_DESCRIPTION_LENGTH) {
        return new NextResponse(`Description is required (max ${MAX_DESCRIPTION_LENGTH} chars)`, { status: 400 });
      }

      const now = new Date();
      const createdAt = coerceDate(current.createdAt);
      const editCountRaw = current.editCount;
      const editCount = typeof editCountRaw === 'number' && Number.isFinite(editCountRaw) ? editCountRaw : Number(editCountRaw ?? 0);

      if (!withinMinutes(createdAt, EDIT_WINDOW_MINUTES, now)) {
        return new NextResponse('Edit window expired', { status: 403 });
      }
      if (editCount >= MAX_EDITS_PER_SUBMISSION) {
        return new NextResponse('Edit limit reached', { status: 403 });
      }
    }

    if (statusChanged) {
      if (!viewerIsAdmin) {
        return new NextResponse('Forbidden', { status: 403 });
      }
      if (!isFeedbackStatus(nextStatusRaw)) {
        return new NextResponse('Invalid status', { status: 400 });
      }
    }

    if (!contentChanged && !statusChanged) {
      const reload = await database.execute(sql`
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
          COALESCE(s.edit_count, 0)::int AS "editCount",
          s.last_edited_at AS "lastEditedAt",
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
        WHERE s.id = ${id}
        LIMIT 1;
      `);
      const item = reload.rows?.[0];
      if (!item) return new NextResponse('Not found', { status: 404 });

      const now = new Date();
      const createdAt = coerceDate((item as { createdAt?: unknown } | null)?.createdAt);
      const editCountRaw = (item as { editCount?: unknown } | null)?.editCount;
      const editCount = typeof editCountRaw === 'number' && Number.isFinite(editCountRaw) ? editCountRaw : Number(editCountRaw ?? 0);
      const viewerCanEdit = viewerIsAuthor && withinMinutes(createdAt, EDIT_WINDOW_MINUTES, now) && editCount < MAX_EDITS_PER_SUBMISSION;
      const viewerCanDelete = viewerIsAuthor && withinMinutes(createdAt, DELETE_WINDOW_MINUTES, now);

      return NextResponse.json({ ...item, viewerIsAdmin, viewerCanEdit, viewerCanDelete });
    }

    const now = new Date();
    const setFragments = [];

    if (contentChanged) {
      setFragments.push(sql`title = ${nextTitle}`);
      setFragments.push(sql`description = ${nextDescription}`);
      setFragments.push(sql`edit_count = edit_count + 1`);
      setFragments.push(sql`last_edited_at = ${now}`);
    }

    if (statusChanged) {
      setFragments.push(sql`status = ${nextStatusRaw}`);
    }

    setFragments.push(sql`updated_at = ${now}`);

    await database.execute(sql`
      UPDATE feedback_submissions
      SET ${sql.join(setFragments, sql`, `)}
      WHERE id = ${id};
    `);

    const reload = await database.execute(sql`
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
        COALESCE(s.edit_count, 0)::int AS "editCount",
        s.last_edited_at AS "lastEditedAt",
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
      WHERE s.id = ${id}
      LIMIT 1;
    `);

    const item = reload.rows?.[0];
    if (!item) return new NextResponse('Not found', { status: 404 });

    const createdAt = coerceDate((item as { createdAt?: unknown } | null)?.createdAt);
    const editCountRaw = (item as { editCount?: unknown } | null)?.editCount;
    const editCount = typeof editCountRaw === 'number' && Number.isFinite(editCountRaw) ? editCountRaw : Number(editCountRaw ?? 0);
    const viewerCanEdit = viewerIsAuthor && withinMinutes(createdAt, EDIT_WINDOW_MINUTES, now) && editCount < MAX_EDITS_PER_SUBMISSION;
    const viewerCanDelete = viewerIsAuthor && withinMinutes(createdAt, DELETE_WINDOW_MINUTES, now);

    return NextResponse.json({
      ...item,
      viewerIsAdmin,
      viewerCanEdit,
      viewerCanDelete,
    });
  } catch (error) {
    console.error('[FEEDBACK_ID_PATCH]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }
    const database = db;

    const { id } = await params;
    if (!id) {
      return new NextResponse('Missing id', { status: 400 });
    }

    const currentResult = await database.execute(sql`
      SELECT
        user_id AS "userId",
        created_at AS "createdAt"
      FROM feedback_submissions
      WHERE id = ${id}
      LIMIT 1;
    `);

    const current = currentResult.rows?.[0] as { userId?: unknown; createdAt?: unknown } | undefined;
    if (!current) {
      return new NextResponse('Not found', { status: 404 });
    }

    if (current.userId !== userId) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    const now = new Date();
    const createdAt = coerceDate(current.createdAt);
    if (!withinMinutes(createdAt, DELETE_WINDOW_MINUTES, now)) {
      return new NextResponse('Delete window expired', { status: 403 });
    }

    const deleted = await database.execute(sql`
      DELETE FROM feedback_submissions
      WHERE id = ${id}
        AND user_id = ${userId}
      RETURNING id;
    `);

    if (!deleted.rows?.length) {
      return new NextResponse('Not found', { status: 404 });
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error('[FEEDBACK_ID_DELETE]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
