import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../db';
import { meals, household_members } from '../../../db/schema';
import { eq, inArray, and } from 'drizzle-orm';
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

    // 1. Get user's households to filter meals
    const memberships = await db.select().from(household_members).where(eq(household_members.userId, userId));
    const householdIds = memberships.map(m => m.householdId);

    if (householdIds.length === 0) {
        return NextResponse.json([]);
    }

    // 2. Fetch meals only for those households
    const userMeals = await db.select().from(meals).where(inArray(meals.householdId, householdIds));

    // 3. Format for client
    const formattedMeals = userMeals.map(m => ({
        ...m,
        ingredients: m.ingredients,
        instructions: m.instructions
    }));

    return NextResponse.json(formattedMeals);

  } catch (error) {
    console.error('[MEALS_GET]', error);
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

    const body = await req.json();
    
    // Verify user belongs to the target household
    if (body.householdId) {
        const userMembership = await db.select().from(household_members).where(
            and(
                eq(household_members.householdId, body.householdId),
                eq(household_members.userId, userId)
            )
        );

        if (userMembership.length === 0) {
             return new NextResponse("You are not a member of this household", { status: 403 });
        }
    }
    
    const id = body.id || uuidv4();
    const newMeal = {
      ...body,
      id,
      createdBy: userId, // Enforce creator
      createdAt: new Date()
    };

    await db.insert(meals).values(newMeal);

    return NextResponse.json(newMeal);

  } catch (error) {
    console.error('[MEALS_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
