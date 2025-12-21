import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { users } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export async function POST(req: Request) {
  try {
    const { userId, sessionId, orgId, getToken } = await auth();
    if (!userId) {
      console.error("[USERS_POST] No userId from auth()");
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        console.error("[USERS_POST] db not configured");
        return new NextResponse("Database not configured", { status: 500 });
    }

    const body = await req.json();
    const { id, name, email, avatar } = body;

    if (!id || !name || !email) {
        return new NextResponse("Missing required fields", { status: 400 });
    }

    // Ensure user can only upsert themselves
    if (id !== userId) {
        console.error("[USERS_POST] Forbidden: id mismatch", { id, userId });
        return new NextResponse("Forbidden", { status: 403 });
    }

    console.log("[USERS_POST] Auth ok", {
      userId,
      sessionId,
      orgId,
      hasDb: !!db,
      namePresent: !!name,
      emailPresent: !!email,
    });

    const existing = await db.select().from(users).where(eq(users.id, id));
    
    if (existing.length === 0) {
      const newUser = {
        id,
        name,
        email,
        avatar,
        createdAt: new Date()
      };
      await db.insert(users).values(newUser);
      return NextResponse.json(newUser);
    } else {
        // If exists, maybe update? The original code was upsert-like but only inserted if missing.
        // Let's stick to "get existing" if it exists, or update if fields changed?
        // The original upsertUser code: if existing, return existing.
        return NextResponse.json(existing[0]);
    }

  } catch (error) {
    console.error('[USERS_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
