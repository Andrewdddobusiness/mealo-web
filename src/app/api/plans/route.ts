import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../db';
import { plans, household_members } from '../../../db/schema';
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
    const { householdId, mealId, date, isCompleted } = body;

    if (!householdId || !mealId || !date) {
        return new NextResponse("Missing required fields", { status: 400 });
    }

    // Verify membership
    const userMembership = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, householdId),
            eq(household_members.userId, userId)
        )
    );

    if (userMembership.length === 0) {
         return new NextResponse("You are not a member of this household", { status: 403 });
    }

    const id = uuidv4();
    const newPlan = {
      id,
      householdId,
      mealId,
      date,
      isCompleted: isCompleted || false,
      createdAt: new Date()
    };

    try {
      await db.insert(plans).values(newPlan);
    } catch (e: any) {
      // Common: mealId is a global meal ID (not imported), which violates FK plans.meal_id -> meals.id.
      const code = e?.code as string | undefined;
      if (code === '23503' || /foreign key/i.test(String(e?.message ?? ''))) {
        return new NextResponse("Meal must be imported before it can be scheduled", { status: 400 });
      }
      throw e;
    }

    return NextResponse.json(newPlan);

  } catch (error) {
    console.error('[PLANS_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}

export async function DELETE(req: Request) {
    try {
        const userId = await getUserIdFromRequest(req);
        if (!userId) {
          return new NextResponse("Unauthorized", { status: 401 });
        }
    
        if (!db) {
            return new NextResponse("Database not configured", { status: 500 });
        }

        const { searchParams } = new URL(req.url);
        const id = searchParams.get('id');

        if (!id) {
            return new NextResponse("ID is required", { status: 400 });
        }

        // We need to verify that the plan belongs to a household the user is in.
        // This is a bit tricky with just the plan ID.
        // 1. Fetch the plan to get householdId
        const plan = await db.select().from(plans).where(eq(plans.id, id));
        
        if (plan.length === 0) {
            return new NextResponse("Plan not found", { status: 404 });
        }

        const householdId = plan[0].householdId;

        // 2. Verify membership
        const userMembership = await db.select().from(household_members).where(
            and(
                eq(household_members.householdId, householdId),
                eq(household_members.userId, userId)
            )
        );
    
        if (userMembership.length === 0) {
             return new NextResponse("You are not a member of this household", { status: 403 });
        }

        await db.delete(plans).where(eq(plans.id, id));

        return NextResponse.json({ success: true });

    } catch (error) {
        console.error('[PLANS_DELETE]', error);
        return new NextResponse("Internal Error", { status: 500 });
    }
}
