import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { invites, household_members } from '../../../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { addDays } from 'date-fns';

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
    const { householdId } = body;

    if (!householdId) {
        return new NextResponse("Household ID is required", { status: 400 });
    }

    // Verify user is a member (or owner?) of the household
    // Ideally only owners can invite? The original code didn't strictly enforce owner for creating invites, 
    // but `removeMember` did. Let's enforce membership at least.
    const userMembership = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, householdId),
            eq(household_members.userId, userId)
        )
    );

    if (userMembership.length === 0) {
         return new NextResponse("You are not a member of this household", { status: 403 });
    }

    const token = uuidv4();
    const expiresAt = addDays(new Date(), 2); // 48 hours

    const newInvite = {
        id: uuidv4(),
        householdId,
        token,
        expiresAt,
        usesLeft: null, // null = multi-use
        createdBy: userId,
        createdAt: new Date()
    };

    await db.insert(invites).values(newInvite);

    const webUrl = process.env.EXPO_PUBLIC_WEB_APP_URL || 'https://mealo.website';
    const inviteUrl = `${webUrl}/invite/${token}`;

    return NextResponse.json({ inviteUrl, token, expiresAt });

  } catch (error) {
    console.error('[INVITES_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
