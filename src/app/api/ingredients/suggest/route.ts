import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../db';
import { sql } from 'drizzle-orm';

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
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

    const { searchParams } = new URL(req.url);
    const qRaw = searchParams.get('q') ?? '';
    const q = normalizeQuery(qRaw);
    const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 12) || 12, 1), 25);

    if (!q) {
      const result = await db.execute(sql`
        WITH user_candidates AS (
          SELECT
            name,
            name_normalized,
            category,
            is_global,
            created_by,
            use_count,
            last_used_at
          FROM ingredients
          WHERE created_by = ${userId} AND is_global = false
          ORDER BY last_used_at DESC NULLS LAST, use_count DESC, name
          LIMIT 50
        ),
        global_candidates AS (
          SELECT
            name,
            name_normalized,
            category,
            is_global,
            created_by,
            use_count,
            last_used_at
          FROM ingredients
          WHERE is_global = true
          ORDER BY use_count DESC, name
          LIMIT 50
        ),
        candidates AS (
          SELECT *, 0 AS scope_rank FROM user_candidates
          UNION ALL
          SELECT *, 1 AS scope_rank FROM global_candidates
        ),
        ranked AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY name_normalized
              ORDER BY scope_rank, use_count DESC, last_used_at DESC NULLS LAST, name
            ) AS rn
          FROM candidates
        )
        SELECT
          id,
          name,
          category,
          CASE WHEN created_by = ${userId} THEN true ELSE false END AS "isPersonal"
        FROM ranked
        WHERE rn = 1
        ORDER BY scope_rank, use_count DESC, last_used_at DESC NULLS LAST, name
        LIMIT ${limit};
      `);

      return NextResponse.json(result.rows ?? []);
    }

    const likeStart = `${q}%`;
    const likeWord = `% ${q}%`;
    const enableWordMatch = q.length >= 3;

    const result = await db.execute(sql`
      WITH candidates AS (
        SELECT
          name,
          name_normalized,
          category,
          is_global,
          created_by,
          use_count,
          last_used_at,
          0 AS scope_rank
        FROM ingredients
        WHERE created_by = ${userId}
          AND is_global = false
          AND (name_normalized LIKE ${likeStart} OR (${enableWordMatch} AND name_normalized LIKE ${likeWord}))

        UNION ALL

        SELECT
          name,
          name_normalized,
          category,
          is_global,
          created_by,
          use_count,
          last_used_at,
          1 AS scope_rank
        FROM ingredients
        WHERE is_global = true
          AND (name_normalized LIKE ${likeStart} OR (${enableWordMatch} AND name_normalized LIKE ${likeWord}))
      ),
      ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY name_normalized
            ORDER BY scope_rank, use_count DESC, last_used_at DESC NULLS LAST, name
          ) AS rn
        FROM candidates
      )
      SELECT
        id,
        name,
        category,
        CASE WHEN created_by = ${userId} THEN true ELSE false END AS "isPersonal"
      FROM ranked
      WHERE rn = 1
      ORDER BY scope_rank, use_count DESC, last_used_at DESC NULLS LAST, name
      LIMIT ${limit};
    `);

    return NextResponse.json(result.rows ?? []);
  } catch (error) {
    console.error('[INGREDIENTS_SUGGEST_GET]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
