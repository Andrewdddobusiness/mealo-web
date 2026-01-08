import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { ensureDbUser } from '@/lib/ensureDbUser';
import { db } from '../../../db';
import { households, household_members, users, plans } from '../../../db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { isBodyTooLarge, validateHouseholdName } from '@/lib/validation';

export async function GET(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }
    const database = db;

    // 1) Resolve household ids (member OR owner) in one round trip.
    // We keep the owner fallback for legacy data where household_members might be missing.
    const idResult = await database.execute(sql`
      SELECT household_id AS id FROM household_members WHERE user_id = ${userId}
      UNION
      SELECT id FROM households WHERE owner_id = ${userId}
    `);
    const allIds = Array.from(
      new Set(
        (idResult.rows ?? [])
          .map((row) => (row as { id?: unknown }).id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    if (allIds.length === 0) {
      return NextResponse.json([]);
    }

    // 2) Fetch household details + related data in bulk (avoid N+1 queries).
    const [userHouseholds, allPlans, membersRel] = await Promise.all([
      database.select().from(households).where(inArray(households.id, allIds)),
      database.select().from(plans).where(inArray(plans.householdId, allIds)),
      database
        .select({
          householdId: household_members.householdId,
          user: users,
          role: household_members.role,
        })
        .from(household_members)
        .innerJoin(users, eq(household_members.userId, users.id))
        .where(inArray(household_members.householdId, allIds)),
    ]);

    const plansByHouseholdId = new Map<string, typeof allPlans>();
    for (const plan of allPlans) {
      const list = plansByHouseholdId.get(plan.householdId) ?? [];
      list.push({
        ...plan,
        isCompleted: plan.isCompleted ?? false,
      });
      plansByHouseholdId.set(plan.householdId, list);
    }

    const membersByHouseholdId = new Map<
      string,
      Array<{ id: string; name: string; email: string; avatarUrl: string | null; role: string }>
    >();
    for (const row of membersRel) {
      const list = membersByHouseholdId.get(row.householdId) ?? [];
      list.push({
        id: row.user.id,
        name: row.user.name,
        email: row.user.email,
        avatarUrl: row.user.avatar,
        role: row.role,
      });
      membersByHouseholdId.set(row.householdId, list);
    }

    const householdsWithDetails = userHouseholds.map((h) => {
      const householdPlans = plansByHouseholdId.get(h.id) ?? [];
      const members = membersByHouseholdId.get(h.id) ?? [];
      return {
        ...h,
        memberIds: members.map((m) => m.id),
        shoppingList: h.shoppingList,
        plannedMeals: householdPlans.map((p) => ({
          ...p,
          createdAt: p.createdAt,
        })),
        members,
      };
    });

    return NextResponse.json(householdsWithDetails);

  } catch (error) {
    console.error('[HOUSEHOLDS_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }
    const database = db;

    if (isBodyTooLarge(req, 10_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const body = await req.json().catch(() => null);
    const name = validateHouseholdName((body as any)?.name);
    if (!name) {
      return new NextResponse('Invalid name', { status: 400 });
    }

    // Ensure the authenticated user exists in the DB before inserting FK-dependent rows.
    await ensureDbUser(userId);

    const id = uuidv4();
    const now = new Date();
    const newHousehold = {
      id,
      name,
      ownerId: userId,
      createdBy: userId,
      memberIds: [userId],
      shoppingList: [],
      currency: 'USD',
      createdAt: now,
    };

    // neon-http (HTTP) driver does not support multi-statement transactions.
    // Use a single atomic SQL statement (CTEs) so both inserts succeed or fail together.
    const insertResult = await database.execute(sql`
      WITH inserted_household AS (
        INSERT INTO households (
          id,
          name,
          owner_id,
          created_by,
          member_ids,
          shopping_list,
          currency,
          created_at
        )
        VALUES (
          ${id},
          ${name},
          ${userId},
          ${userId},
          ${JSON.stringify([userId])}::jsonb,
          ${JSON.stringify([])}::jsonb,
          ${'USD'},
          ${now}
        )
        RETURNING *
      ),
      inserted_member AS (
        INSERT INTO household_members (
          id,
          household_id,
          user_id,
          role,
          joined_at
        )
        SELECT
          ${uuidv4()},
          inserted_household.id,
          ${userId},
          'owner',
          ${now}
        FROM inserted_household
        RETURNING 1
      )
      SELECT
        id,
        name,
        owner_id AS "ownerId",
        created_by AS "createdBy",
        member_ids AS "memberIds",
        current_period_start AS "currentPeriodStart",
        current_period_end AS "currentPeriodEnd",
        shopping_list AS "shoppingList",
        currency,
        created_at AS "createdAt"
      FROM inserted_household;
    `);

    const insertedHousehold = insertResult.rows?.[0] ?? newHousehold;

    const res = NextResponse.json(insertedHousehold);
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[HOUSEHOLDS_POST]', error);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "23503") {
      return new NextResponse("Missing required user record", { status: 409 });
    }
    return new NextResponse("Internal Error", { status: 500 });
  }
}
