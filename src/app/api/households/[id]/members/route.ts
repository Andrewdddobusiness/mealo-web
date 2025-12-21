import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../../db';
import { household_members, users } from '../../../../../db/schema';
import { eq, and } from 'drizzle-orm';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const { id } = await params; // householdId

    // Verify membership
    const userMembership = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, id),
            eq(household_members.userId, userId)
        )
    );

    if (userMembership.length === 0) {
         return new NextResponse("You are not a member of this household", { status: 403 });
    }

    const membersRel = await db.select({
        user: users,
        role: household_members.role,
        joinedAt: household_members.joinedAt
    })
    .from(household_members)
    .innerJoin(users, eq(household_members.userId, users.id))
    .where(eq(household_members.householdId, id));

    const members = membersRel.map(m => ({
        ...m.user,
        role: m.role,
        joinedAt: m.joinedAt
    }));

    return NextResponse.json(members);

  } catch (error) {
    console.error('[MEMBERS_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
