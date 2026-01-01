import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../db';

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

    return NextResponse.json(item);
  } catch (error) {
    console.error('[FEEDBACK_ID_GET]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}

