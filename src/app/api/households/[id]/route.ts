import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db';
import { households, household_members } from '../../../../db/schema';
import { eq, and } from 'drizzle-orm';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const { id } = await params;
    const body = await req.json();

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

    // Extract allowed fields to update
    // Currently only shoppingList and name seem relevant
    const { name, shoppingList } = body as Partial<typeof households.$inferInsert>;
    const updateData: Partial<typeof households.$inferInsert> = {};
    if (name) updateData.name = name;
    if (shoppingList) updateData.shoppingList = shoppingList;

    if (Object.keys(updateData).length === 0) {
        return new NextResponse("No valid fields to update", { status: 400 });
    }

    await db.update(households).set(updateData).where(eq(households.id, id));

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[HOUSEHOLD_PUT]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { userId } = await auth();
        if (!userId) {
          return new NextResponse("Unauthorized", { status: 401 });
        }
    
        if (!db) {
            return new NextResponse("Database not configured", { status: 500 });
        }
    
        const { id } = await params;

        // Verify ownership - only owners can delete?
        // The original code didn't strictly enforce owner for deleteHousehold, but it's safer.
        // Let's enforce owner.
        const ownerMembership = await db.select().from(household_members).where(
            and(
                eq(household_members.householdId, id),
                eq(household_members.userId, userId),
                eq(household_members.role, 'owner')
            )
        );
    
        if (ownerMembership.length === 0) {
             return new NextResponse("Only owners can delete a household", { status: 403 });
        }
    
        await db.delete(households).where(eq(households.id, id));
    
        return NextResponse.json({ success: true });
    
      } catch (error) {
        console.error('[HOUSEHOLD_DELETE]', error);
        return new NextResponse("Internal Error", { status: 500 });
      }
}
