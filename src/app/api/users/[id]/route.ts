import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../../db';
import { users } from '../../../../db/schema';
import { eq } from 'drizzle-orm';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const { id } = await params;

    // Users can only fetch themselves? Or maybe other members?
    // For now, let's restrict to self or maybe relax later if needed for member profiles.
    // The mobile app uses getUser(userId) which might be used for other members.
    // Let's allow fetching any user for now (public profile essentially), 
    // but maybe strip sensitive info if any (email?).
    
    const user = await db.select().from(users).where(eq(users.id, id)).limit(1);
    
    if (user.length === 0) {
        return new NextResponse("User not found", { status: 404 });
    }

    return NextResponse.json(user[0]);

  } catch (error) {
    console.error('[USER_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}

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

        if (id !== userId) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        const { name, email, avatar } = body;
        const updateData: any = {};
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (avatar) updateData.avatar = avatar;

        if (Object.keys(updateData).length === 0) {
            return new NextResponse("No valid fields to update", { status: 400 });
        }

        await db.update(users).set(updateData).where(eq(users.id, id));
        
        const updatedUser = await db.select().from(users).where(eq(users.id, id));

        return NextResponse.json(updatedUser[0]);
    
      } catch (error) {
        console.error('[USER_PUT]', error);
        return new NextResponse("Internal Error", { status: 500 });
      }
}
