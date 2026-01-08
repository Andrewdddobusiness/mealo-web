import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../db';
import { users } from '../../../../db/schema';
import { eq } from 'drizzle-orm';
import { isBodyTooLarge, stripControlChars } from '@/lib/validation';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const { id } = await params;

    // Privacy: limit this endpoint to self. Household membership lookups should go through
    // /api/households/:id/members which is already membership-gated.
    if (id !== userId) {
      return new NextResponse("Forbidden", { status: 403 });
    }
    
    const user = await db.select().from(users).where(eq(users.id, id)).limit(1);
    
    if (user.length === 0) {
        return new NextResponse("User not found", { status: 404 });
    }

    const res = NextResponse.json(user[0]);
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[USER_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getUserIdFromRequest(req);
        if (!userId) {
          return new NextResponse("Unauthorized", { status: 401 });
        }
    
        if (!db) {
            return new NextResponse("Database not configured", { status: 500 });
        }
    
        const { id } = await params;
        if (isBodyTooLarge(req, 25_000)) {
          return new NextResponse('Payload too large', { status: 413 });
        }

        const body = await req.json().catch(() => null);
        if (!body || typeof body !== 'object') {
          return new NextResponse('Invalid JSON body', { status: 400 });
        }

        if (id !== userId) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        const { name, email, avatar } = body as Partial<typeof users.$inferInsert>;
        const updateData: Partial<typeof users.$inferInsert> = {};
        if (name !== undefined) {
          if (typeof name !== 'string') return new NextResponse('Invalid name', { status: 400 });
          const cleaned = stripControlChars(name).trim().slice(0, 120);
          if (!cleaned) return new NextResponse('Invalid name', { status: 400 });
          updateData.name = cleaned;
        }
        if (email !== undefined) {
          if (typeof email !== 'string') return new NextResponse('Invalid email', { status: 400 });
          const cleaned = stripControlChars(email).trim().slice(0, 320);
          if (!cleaned) return new NextResponse('Invalid email', { status: 400 });
          updateData.email = cleaned;
        }
        if (avatar !== undefined) {
          if (avatar == null) {
            updateData.avatar = null;
          } else if (typeof avatar === 'string') {
            const cleaned = stripControlChars(avatar).trim().slice(0, 2048);
            updateData.avatar = cleaned || null;
          } else {
            return new NextResponse('Invalid avatar', { status: 400 });
          }
        }

        if (Object.keys(updateData).length === 0) {
            return new NextResponse("No valid fields to update", { status: 400 });
        }

        await db.update(users).set(updateData).where(eq(users.id, id));
        
        const updatedUser = await db.select().from(users).where(eq(users.id, id));

        const res = NextResponse.json(updatedUser[0]);
        res.headers.set('cache-control', 'no-store');
        return res;
    
      } catch (error) {
        console.error('[USER_PUT]', error);
        return new NextResponse("Internal Error", { status: 500 });
      }
}
