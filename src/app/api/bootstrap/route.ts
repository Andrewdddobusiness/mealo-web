import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../db';
import { globalMeals, households, household_members, meals, plans, subscriptions, users } from '../../../db/schema';
import { eq, inArray, sql } from 'drizzle-orm';

function parseBoolean(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
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

    const { searchParams } = new URL(req.url);
    const includeGlobalMeals = parseBoolean(searchParams.get('includeGlobalMeals'));

    // Resolve household ids once and reuse across payload sections.
    //
    // IMPORTANT: only households the user is currently a member of should be returned.
    // Using an owner_id fallback causes a "left" household to reappear for the former owner,
    // which breaks the leave-group UX (especially for 1-member groups).
    const idResult = await database.execute(sql`
      SELECT household_id AS id
      FROM household_members
      WHERE user_id = ${userId}
    `);
    const householdIds = Array.from(
      new Set(
        (idResult.rows ?? [])
          .map((row) => (row as { id?: unknown }).id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    );

    const userRowPromise = database.select().from(users).where(eq(users.id, userId)).limit(1);
    const subscriptionPromise = database.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);

    const householdsPromise = householdIds.length
      ? database.select().from(households).where(inArray(households.id, householdIds))
      : Promise.resolve([]);

    const plansPromise = householdIds.length
      ? database.select().from(plans).where(inArray(plans.householdId, householdIds))
      : Promise.resolve([]);

    const membersPromise = householdIds.length
      ? database
          .select({
            householdId: household_members.householdId,
            user: users,
            role: household_members.role,
          })
          .from(household_members)
          .innerJoin(users, eq(household_members.userId, users.id))
          .where(inArray(household_members.householdId, householdIds))
      : Promise.resolve([]);

    const mealsPromise = householdIds.length
      ? database.select().from(meals).where(inArray(meals.householdId, householdIds))
      : Promise.resolve([]);

    const globalMealsPromise = includeGlobalMeals ? database.select().from(globalMeals) : Promise.resolve(null);

    const [userRows, subscriptionRows, householdRows, planRows, memberRows, mealRows, globalMealRows] =
      await Promise.all([
        userRowPromise,
        subscriptionPromise,
        householdsPromise,
        plansPromise,
        membersPromise,
        mealsPromise,
        globalMealsPromise,
      ]);

    const plansByHouseholdId = new Map<string, typeof planRows>();
    for (const plan of planRows) {
      const list = plansByHouseholdId.get(plan.householdId) ?? [];
      list.push({ ...plan, isCompleted: plan.isCompleted ?? false });
      plansByHouseholdId.set(plan.householdId, list);
    }

    const membersByHouseholdId = new Map<
      string,
      Array<{ id: string; name: string; email: string; avatarUrl: string | null; role: string }>
    >();
    for (const row of memberRows) {
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

    const householdsWithDetails = householdRows.map((h) => {
      const householdPlans = plansByHouseholdId.get(h.id) ?? [];
      const members = membersByHouseholdId.get(h.id) ?? [];
      return {
        ...h,
        memberIds: members.map((m) => m.id),
        plannedMeals: householdPlans.map((p) => ({ ...p, createdAt: p.createdAt })),
        members,
      };
    });

    const formattedMeals = mealRows.map((m) => ({
      ...m,
      ingredients: m.ingredients,
      instructions: m.instructions,
    }));

    const formattedGlobalMeals = (globalMealRows ?? []).map((m) => ({
      ...m,
      ingredients: m.ingredients,
      instructions: m.instructions,
      isPredefined: true,
    }));

    return NextResponse.json({
      user: userRows[0] ?? null,
      subscription: subscriptionRows[0]
        ? {
            productId: subscriptionRows[0].productId,
            currentPeriodStart: subscriptionRows[0].currentPeriodStart,
            expiresAt: subscriptionRows[0].expiresAt,
            isTrial: subscriptionRows[0].isTrial,
            isActive: subscriptionRows[0].isActive,
            autoRenewStatus: subscriptionRows[0].autoRenewStatus,
            updatedAt: subscriptionRows[0].updatedAt,
          }
        : null,
      households: householdsWithDetails,
      meals: formattedMeals,
      globalMeals: includeGlobalMeals ? formattedGlobalMeals : undefined,
    });
  } catch (error) {
    console.error('[BOOTSTRAP_GET]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
