import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { households, household_members, users, plans } from '../../../db/schema';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export async function GET() {
  try {
    const { userId } = await auth();
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
    const { userId } = await auth();
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

    const id = uuidv4();
    const newHousehold = {
      id,
      name,
      ownerId: userId,
      createdBy: userId,
      memberIds: [userId],
      shoppingList: [],
      currency: 'USD',
      createdAt: new Date(),
    };

    // Transaction-like operations
    await database.insert(households).values(newHousehold);
    
    await database.insert(household_members).values({
        id: uuidv4(),
        householdId: id,
        userId: userId,
        role: 'owner',
        joinedAt: new Date()
    });

    return NextResponse.json(newHousehold);

  } catch (error) {
    console.error('[HOUSEHOLDS_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
