import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '../../../db';
import { subscriptions } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const sub = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1);
    
    if (sub.length === 0) {
        return NextResponse.json(null);
    }

    return NextResponse.json(sub[0]);

  } catch (error) {
    console.error('[SUBSCRIPTIONS_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
