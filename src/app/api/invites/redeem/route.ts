import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db';
import { invites, household_members, households } from '../../../../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const body = await req.json();
    const { token } = body;

    if (!token) {
        return new NextResponse("Token is required", { status: 400 });
    }

    // 1. Find invite
    const invite = await db.select().from(invites).where(eq(invites.token, token)).limit(1);
    if (invite.length === 0) {
        return new NextResponse("This link is invalid", { status: 404 });
    }
    
    const inv = invite[0];
    if (new Date() > inv.expiresAt) {
        return new NextResponse("Invite link has expired", { status: 410 });
    }
    if (inv.usesLeft !== null && inv.usesLeft <= 0) {
        return new NextResponse("Invite link has expired", { status: 410 });
    }

    // 2. Check if household exists
    const householdExists = await db.select().from(households).where(eq(households.id, inv.householdId)).limit(1);
    if (householdExists.length === 0) {
        return new NextResponse("Group no longer exists", { status: 404 });
    }

    // 3. Check if user is already a member
    const existingMember = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, inv.householdId),
            eq(household_members.userId, userId)
        )
    );

    if (existingMember.length > 0) {
        return new NextResponse("You are already a member of this group", { status: 409 });
    }

    // 4. Add member
    await db.insert(household_members).values({
        id: uuidv4(),
        householdId: inv.householdId,
        userId: userId,
        role: 'member',
        joinedAt: new Date()
    });

    // 5. Decrement uses
    if (inv.usesLeft !== null) {
        await db.update(invites).set({ usesLeft: inv.usesLeft - 1 }).where(eq(invites.id, inv.id));
    }

    return NextResponse.json({ success: true, householdId: inv.householdId });

  } catch (error) {
    console.error('[INVITES_REDEEM_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
