import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { recordIngredientUsage } from '@/lib/ingredients';
import { normalizeCuisine, normalizeIngredients, normalizeMealName } from '@/lib/normalizeMeal';
import { isBodyTooLarge, validateUuid } from '@/lib/validation';
import { getMealsSelect } from '@/db/compat';
import { db } from '../../../../db';
import { meals, globalMeals, household_members } from '../../../../db/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
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

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const mealsSelect = await getMealsSelect(db);

    if (isBodyTooLarge(req, 25_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const body = await req.json().catch(() => null);
    const globalMealId = validateUuid((body as any)?.globalMealId);
    const householdId = validateUuid((body as any)?.householdId);

    if (!globalMealId || !householdId) {
        return new NextResponse("Missing or invalid required fields", { status: 400 });
    }

    // 1. Verify membership
    const userMembership = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, householdId),
            eq(household_members.userId, userId)
        )
    );

    if (userMembership.length === 0) {
         return new NextResponse("You are not a member of this household", { status: 403 });
    }

    // 2. Fetch global meal
    const globalMeal = await db.select().from(globalMeals).where(eq(globalMeals.id, globalMealId)).limit(1);
    if (globalMeal.length === 0) {
        return new NextResponse("Global meal not found", { status: 404 });
    }
    const gm = globalMeal[0];
    const normalizedName = normalizeMealName(gm.name) ?? gm.name;
    const normalizedIngredients = normalizeIngredients(gm.ingredients);
    const normalizedCuisine = normalizeCuisine(gm.cuisine);

    // 3. Check if already imported (by from_global_meal_id)
    const existing = await db
      .select(mealsSelect)
      .from(meals)
      .where(and(eq(meals.householdId, householdId), eq(meals.fromGlobalMealId, gm.id)))
      .limit(1);

    if (existing.length > 0) {
      try {
        await recordIngredientUsage(db, userId, existing[0].ingredients);
      } catch (error) {
        console.error('[MEAL_IMPORT_EXISTING_INGREDIENT_USAGE]', error);
      }

      return NextResponse.json({
        ...existing[0],
        ingredients: existing[0].ingredients,
        instructions: existing[0].instructions,
      });
    }

    // 4. Repair legacy imports:
    // If a meal was previously "copied" from global meals (same name + ingredients) but didn't set from_global_meal_id,
    // update that row instead of inserting another duplicate.
    const legacyCandidates = await db
      .select(mealsSelect)
      .from(meals)
      .where(
        and(
          eq(meals.householdId, householdId),
          eq(meals.createdBy, userId),
          isNull(meals.fromGlobalMealId),
          sql`lower(${meals.name}) = ${normalizedName.toLowerCase()}`,
        ),
      );

    const gmKey = canonicalIngredientsKey(normalizedIngredients);
    const legacyMatch = legacyCandidates.find((m) => canonicalIngredientsKey(m.ingredients) === gmKey);

    if (legacyMatch) {
      const updated = {
        name: normalizedName,
        fromGlobalMealId: gm.id,
        description: gm.description,
        ingredients: Array.isArray(normalizedIngredients) ? normalizedIngredients : gm.ingredients,
        instructions: gm.instructions,
        image: gm.image,
        cuisine: normalizedCuisine ?? gm.cuisine,
      };

      await db.update(meals).set(updated).where(eq(meals.id, legacyMatch.id));

      try {
        await recordIngredientUsage(db, userId, updated.ingredients);
      } catch (error) {
        console.error('[MEAL_IMPORT_LEGACY_INGREDIENT_USAGE]', error);
      }

      return NextResponse.json({
        ...legacyMatch,
        ...updated,
        ingredients: updated.ingredients,
        instructions: gm.instructions,
      });
    }

    // 5. Import
    const newMeal = {
        id: uuidv4(),
        householdId,
        name: normalizedName,
        description: gm.description,
        ingredients: Array.isArray(normalizedIngredients) ? normalizedIngredients : gm.ingredients,
        instructions: gm.instructions,
        image: gm.image,
        cuisine: normalizedCuisine ?? gm.cuisine,
        fromGlobalMealId: gm.id,
        rating: 0,
        isFavorite: false,
        createdAt: new Date(),
        createdBy: userId
    };

    await db.insert(meals).values(newMeal);

    try {
      await recordIngredientUsage(db, userId, newMeal.ingredients);
    } catch (error) {
      console.error('[MEAL_IMPORT_POST_INGREDIENT_USAGE]', error);
    }

    const res = NextResponse.json(newMeal);
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[MEAL_IMPORT_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
