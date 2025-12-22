import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../db';
import { meals, household_members } from '../../../db/schema';
import { eq, inArray, and, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function canonicalIngredientsKey(ingredients: unknown): string {
  if (!Array.isArray(ingredients)) return '';
  const parts = ingredients
    .map((raw) => {
      const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<
        string,
        unknown
      >;
      const name = normalizeText(obj.name);
      if (!name) return '';
      const unit = normalizeText(obj.unit);
      const quantity = obj.quantity == null ? '' : String(obj.quantity).trim();
      return `${name}|${quantity}|${unit}`;
    })
    .filter(Boolean)
    .sort();
  return parts.join(';');
}

export async function GET(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    // 1. Get user's households to filter meals
    const memberships = await db.select().from(household_members).where(eq(household_members.userId, userId));
    const householdIds = memberships.map(m => m.householdId);

    if (householdIds.length === 0) {
        return NextResponse.json([]);
    }

    // 2. Fetch meals only for those households
    const userMeals = await db.select().from(meals).where(inArray(meals.householdId, householdIds));

    // 3. Format for client
    const formattedMeals = userMeals.map(m => ({
        ...m,
        ingredients: m.ingredients,
        instructions: m.instructions
    }));

    return NextResponse.json(formattedMeals);

  } catch (error) {
    console.error('[MEALS_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const body = await req.json();

    const householdId = typeof body?.householdId === 'string' ? body.householdId : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const fromGlobalMealId = typeof body?.fromGlobalMealId === 'string' ? body.fromGlobalMealId : null;

    if (!householdId || !name) {
      return new NextResponse("Missing required fields", { status: 400 });
    }
    
    // Verify user belongs to the target household
    const userMembership = await db.select().from(household_members).where(
      and(eq(household_members.householdId, householdId), eq(household_members.userId, userId)),
    );

    if (userMembership.length === 0) {
      return new NextResponse("You are not a member of this household", { status: 403 });
    }

    // De-dupe:
    // 1) Imported meals should be unique per household+from_global_meal_id.
    if (fromGlobalMealId) {
      const existingImported = await db
        .select()
        .from(meals)
        .where(and(eq(meals.householdId, householdId), eq(meals.fromGlobalMealId, fromGlobalMealId)))
        .limit(1);

      if (existingImported.length > 0) {
        return NextResponse.json({
          ...existingImported[0],
          ingredients: existingImported[0].ingredients,
          instructions: existingImported[0].instructions,
        });
      }
    } else {
      // 2) Custom meals should be unique per household+created_by+name+ingredients.
      const candidates = await db
        .select()
        .from(meals)
        .where(
          and(
            eq(meals.householdId, householdId),
            eq(meals.createdBy, userId),
            eq(meals.name, name),
            isNull(meals.fromGlobalMealId),
          ),
        );

      const bodyKey = canonicalIngredientsKey(body?.ingredients);
      if (bodyKey) {
        const match = candidates.find((m) => canonicalIngredientsKey(m.ingredients) === bodyKey);
        if (match) {
          return NextResponse.json({
            ...match,
            ingredients: match.ingredients,
            instructions: match.instructions,
          });
        }
      }
    }
    
    const id = typeof body?.id === 'string' ? body.id : uuidv4();

    const newMeal: typeof meals.$inferInsert = {
      id,
      householdId,
      name,
      description: typeof body?.description === 'string' ? body.description : undefined,
      ingredients: Array.isArray(body?.ingredients) ? body.ingredients : [],
      instructions: Array.isArray(body?.instructions) ? body.instructions : [],
      fromGlobalMealId,
      rating: typeof body?.rating === 'number' ? body.rating : undefined,
      isFavorite: typeof body?.isFavorite === 'boolean' ? body.isFavorite : undefined,
      userNotes: typeof body?.userNotes === 'string' ? body.userNotes : undefined,
      image: typeof body?.image === 'string' ? body.image : undefined,
      cuisine: typeof body?.cuisine === 'string' ? body.cuisine : undefined,
      createdBy: userId, // Enforce creator
      createdAt: new Date(),
    };

    await db.insert(meals).values(newMeal);

    return NextResponse.json(newMeal);

  } catch (error) {
    console.error('[MEALS_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
