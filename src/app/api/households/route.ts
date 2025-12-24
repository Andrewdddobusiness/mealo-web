import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { ensureDbUser } from '@/lib/ensureDbUser';
import { db } from '../../../db';
import { households, household_members, users, plans } from '../../../db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

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

    // 1. Get households where user is a member
    const memberships = await database.select().from(household_members).where(eq(household_members.userId, userId));
    const householdIds = memberships.map(m => m.householdId);

    // 2. Also fetch owned households (legacy/safety)
    const ownedHouseholds = await database.select().from(households).where(eq(households.createdBy, userId));
    const ownedIds = ownedHouseholds.map(h => h.id);

    const allIds = Array.from(new Set([...householdIds, ...ownedIds]));

    if (allIds.length === 0) {
      return NextResponse.json([]);
    }

    // 3. Fetch household details
    const userHouseholds = await database.select().from(households).where(inArray(households.id, allIds));

    // 4. Enrich with members and plans (similar to mobile logic)
    const householdsWithDetails = await Promise.all(userHouseholds.map(async (h) => {
        const householdPlans = await database.select().from(plans).where(eq(plans.householdId, h.id));
        
        const membersRel = await database.select({
            user: users,
            role: household_members.role
        })
        .from(household_members)
        .innerJoin(users, eq(household_members.userId, users.id))
        .where(eq(household_members.householdId, h.id));

        const members = membersRel.map(m => ({
            id: m.user.id,
            name: m.user.name,
            email: m.user.email,
            avatarUrl: m.user.avatar,
            role: m.role
        }));

        return {
            ...h,
            memberIds: members.map(m => m.id),
            shoppingList: h.shoppingList,
            plannedMeals: householdPlans.map(p => ({
                ...p,
                isCompleted: p.isCompleted ?? false,
                createdAt: p.createdAt
            })),
            members: members
        };
    }));

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

    const body = await req.json();
    const { name } = body;

    if (!name) {
      return new NextResponse("Name is required", { status: 400 });
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

    return NextResponse.json(insertedHousehold);

  } catch (error) {
    console.error('[HOUSEHOLDS_POST]', error);
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "23503") {
      return new NextResponse("Missing required user record", { status: 409 });
    }
    return new NextResponse("Internal Error", { status: 500 });
  }
}
