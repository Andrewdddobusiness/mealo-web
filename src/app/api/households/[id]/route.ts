import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../db';
import { households, household_members } from '../../../../db/schema';
import { eq, and } from 'drizzle-orm';
import {
  isBodyTooLarge,
  sanitizeShoppingList,
  validateHouseholdName,
  validatePlanDate,
  validateUuid,
} from '@/lib/validation';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const { id: idRaw } = await params;
    const id = validateUuid(idRaw);
    if (!id) {
      return new NextResponse("Invalid id", { status: 400 });
    }

    if (isBodyTooLarge(req, 300_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return new NextResponse('Invalid JSON body', { status: 400 });
    }

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
    const { name, shoppingList, currentPeriodStart, currentPeriodEnd } = body as Partial<typeof households.$inferInsert>;
    const updateData: Partial<typeof households.$inferInsert> = {};

    if (name !== undefined) {
      const cleaned = validateHouseholdName(name);
      if (!cleaned) return new NextResponse('Invalid name', { status: 400 });
      updateData.name = cleaned;
    }

    if (shoppingList !== undefined) {
      const sanitized = sanitizeShoppingList(shoppingList);
      if (!sanitized) return new NextResponse('Invalid shoppingList', { status: 400 });
      updateData.shoppingList = sanitized as any;
    }

    if (currentPeriodStart !== undefined) {
      if (currentPeriodStart == null) {
        updateData.currentPeriodStart = null;
      } else {
        const cleaned = validatePlanDate(currentPeriodStart);
        if (!cleaned) return new NextResponse('Invalid currentPeriodStart', { status: 400 });
        updateData.currentPeriodStart = cleaned;
      }
    }

    if (currentPeriodEnd !== undefined) {
      if (currentPeriodEnd == null) {
        updateData.currentPeriodEnd = null;
      } else {
        const cleaned = validatePlanDate(currentPeriodEnd);
        if (!cleaned) return new NextResponse('Invalid currentPeriodEnd', { status: 400 });
        updateData.currentPeriodEnd = cleaned;
      }
    }

    if (Object.keys(updateData).length === 0) {
        return new NextResponse("No valid fields to update", { status: 400 });
    }

    await db.update(households).set(updateData).where(eq(households.id, id));

    const res = NextResponse.json({ success: true });
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[HOUSEHOLD_PUT]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getUserIdFromRequest(req);
        if (!userId) {
          return new NextResponse("Unauthorized", { status: 401 });
        }
    
        if (!db) {
            return new NextResponse("Database not configured", { status: 500 });
        }
    
        const { id: idRaw } = await params;
        const id = validateUuid(idRaw);
        if (!id) {
          return new NextResponse("Invalid id", { status: 400 });
        }

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
    
        const res = NextResponse.json({ success: true });
        res.headers.set('cache-control', 'no-store');
        return res;
    
      } catch (error) {
        console.error('[HOUSEHOLD_DELETE]', error);
        return new NextResponse("Internal Error", { status: 500 });
      }
}
