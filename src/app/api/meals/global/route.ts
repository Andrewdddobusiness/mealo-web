import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../db';
import { globalMeals } from '../../../../db/schema';

export async function GET(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const allGlobalMeals = await db.select().from(globalMeals);

    const formatted = allGlobalMeals.map(m => ({
        ...m,
        ingredients: m.ingredients,
        instructions: m.instructions,
        isPredefined: true
    }));

    return NextResponse.json(formatted);

  } catch (error) {
    console.error('[GLOBAL_MEALS_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
