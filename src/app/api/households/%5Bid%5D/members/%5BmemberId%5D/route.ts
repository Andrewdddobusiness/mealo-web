import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../../../db';
import { household_members } from '../../../../../../db/schema';
import { eq, and } from 'drizzle-orm';

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; memberId: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const { id, memberId } = await params; // id = householdId

    // 1. Verify acting user is owner (unless leaving self?)
    // If removing self, it's "leave". If removing other, must be owner.
    
    if (memberId === userId) {
        // Leaving household
        // Just delete the membership
        await db.delete(household_members).where(
            and(
                eq(household_members.householdId, id),
                eq(household_members.userId, userId)
            )
        );
        return NextResponse.json({ success: true });
    }

    // Removing another member
    const actorMembership = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, id),
            eq(household_members.userId, userId),
            eq(household_members.role, 'owner')
        )
    );

    if (actorMembership.length === 0) {
        return new NextResponse("Only owners can remove members", { status: 403 });
    }

    // Remove the member
    await db.delete(household_members).where(
        and(
            eq(household_members.householdId, id),
            eq(household_members.userId, memberId)
        )
    );

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[MEMBER_DELETE]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
