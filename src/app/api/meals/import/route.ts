import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../db';
import { meals, globalMeals, household_members } from '../../../../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const body = await req.json();
    const { globalMealId, householdId } = body;

    if (!globalMealId || !householdId) {
        return new NextResponse("Missing required fields", { status: 400 });
    }

    // 1. Verify membership
    const userMembership = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, householdId),
            eq(household_members.userId, userId)
        )
    );

    if (userMembership.length === 0) {
         return new NextResponse("You are not a member of this household", { status: 403 });
    }

    // 2. Check if already imported
    const existing = await db.select().from(meals).where(
        and(
            eq(meals.householdId, householdId),
            eq(meals.fromGlobalMealId, globalMealId)
        )
    ).limit(1);

    if (existing.length > 0) {
        return NextResponse.json({
            ...existing[0],
            ingredients: existing[0].ingredients,
            instructions: existing[0].instructions
        });
    }

    // 3. Fetch global meal
    const globalMeal = await db.select().from(globalMeals).where(eq(globalMeals.id, globalMealId)).limit(1);
    if (globalMeal.length === 0) {
        return new NextResponse("Global meal not found", { status: 404 });
    }
    const gm = globalMeal[0];

    // 4. Import
    const newMeal = {
        id: uuidv4(),
        householdId,
        name: gm.name,
        description: gm.description,
        ingredients: gm.ingredients,
        instructions: gm.instructions,
        image: gm.image,
        cuisine: gm.cuisine,
        fromGlobalMealId: gm.id,
        rating: 0,
        isFavorite: false,
        createdAt: new Date(),
        createdBy: userId
    };

    await db.insert(meals).values(newMeal);

    return NextResponse.json(newMeal);

  } catch (error) {
    console.error('[MEAL_IMPORT_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
