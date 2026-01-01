import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

import { getUserIdFromRequest } from '@/lib/requestAuth';
import { ensureDbUser } from '@/lib/ensureDbUser';
import { db } from '../../../../../db';

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

    await ensureDbUser(userId);

    const now = new Date();
    const voteId = uuidv4();

    // Idempotent upvote (one per user). Returns updated vote count.
    const result = await database.execute(sql`
      WITH inserted AS (
        INSERT INTO feedback_votes (
          id,
          submission_id,
          user_id,
          created_at
        )
        VALUES (
          ${voteId},
          ${submissionId},
          ${userId},
          ${now}
        )
        ON CONFLICT (submission_id, user_id) DO NOTHING
        RETURNING 1
      )
      SELECT COUNT(*)::int AS "voteCount"
      FROM feedback_votes
      WHERE submission_id = ${submissionId};
    `);

    const voteCount = (result.rows?.[0] as { voteCount?: unknown } | undefined)?.voteCount;

    return NextResponse.json({
      voteCount: typeof voteCount === 'number' ? voteCount : Number(voteCount ?? 0),
      viewerHasVoted: true,
    });
  } catch (error) {
    console.error('[FEEDBACK_VOTE_POST]', error);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '23503') {
      return new NextResponse('Not found', { status: 404 });
    }
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

    const { id: submissionId } = await params;
    if (!submissionId) {
      return new NextResponse('Missing id', { status: 400 });
    }

    const result = await database.execute(sql`
      WITH deleted AS (
        DELETE FROM feedback_votes
        WHERE submission_id = ${submissionId}
          AND user_id = ${userId}
        RETURNING 1
      )
      SELECT COUNT(*)::int AS "voteCount"
      FROM feedback_votes
      WHERE submission_id = ${submissionId};
    `);

    const voteCount = (result.rows?.[0] as { voteCount?: unknown } | undefined)?.voteCount;

    return NextResponse.json({
      voteCount: typeof voteCount === 'number' ? voteCount : Number(voteCount ?? 0),
      viewerHasVoted: false,
    });
  } catch (error) {
    console.error('[FEEDBACK_VOTE_DELETE]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}

