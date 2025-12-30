import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { recordIngredientUsage } from '@/lib/ingredients';
import { normalizeCuisine, normalizeIngredients, normalizeMealName } from '@/lib/normalizeMeal';
import { db } from '../../../../db';
import { meals, household_members } from '../../../../db/schema';
import { eq, and } from 'drizzle-orm';

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
    const body = await req.json();

    // 1. Fetch meal to check household ownership
    const meal = await db.select().from(meals).where(eq(meals.id, id)).limit(1);
    if (meal.length === 0) {
        return new NextResponse("Meal not found", { status: 404 });
    }
    const householdId = meal[0].householdId;

    // 2. Verify membership
    const userMembership = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, householdId),
            eq(household_members.userId, userId)
        )
    );

    if (userMembership.length === 0) {
         return new NextResponse("You are not a member of this household", { status: 403 });
    }

    // 3. Update meal
    // Extract allowed fields
    const { name, description, ingredients, instructions, image, cuisine, rating, isFavorite, userNotes } =
      body as Partial<typeof meals.$inferInsert>;
    const updateData: Partial<typeof meals.$inferInsert> = {};
    
    if (name !== undefined) updateData.name = normalizeMealName(name) ?? name;
    if (description !== undefined) updateData.description = description;
    if (ingredients !== undefined) updateData.ingredients = normalizeIngredients(ingredients) as typeof ingredients;
    if (instructions !== undefined) updateData.instructions = instructions;
    if (image !== undefined) updateData.image = image;
    if (cuisine !== undefined) updateData.cuisine = normalizeCuisine(cuisine) ?? cuisine;
    if (rating !== undefined) updateData.rating = rating;
    if (isFavorite !== undefined) updateData.isFavorite = isFavorite;
    if (userNotes !== undefined) updateData.userNotes = userNotes;

    if (Object.keys(updateData).length === 0) {
        return new NextResponse("No valid fields to update", { status: 400 });
    }

    await db.update(meals).set(updateData).where(eq(meals.id, id));

    if (updateData.ingredients !== undefined) {
      try {
        await recordIngredientUsage(db, userId, updateData.ingredients);
      } catch (error) {
        console.error('[MEAL_PUT_INGREDIENT_USAGE]', error);
      }
    }

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('[MEAL_PUT]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
