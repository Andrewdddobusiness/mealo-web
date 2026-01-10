import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { recordIngredientUsage } from '@/lib/ingredients';
import { normalizeCuisine, normalizeIngredients, normalizeMealName } from '@/lib/normalizeMeal';
import {
  isBodyTooLarge,
  normalizeWhitespace,
  sanitizeStringArray,
  stripControlChars,
  validateMealName,
  validateRecordId,
} from '@/lib/validation';
import { db } from '../../../../db';
import { meals, household_members } from '../../../../db/schema';
import { eq, and } from 'drizzle-orm';

const MAX_INGREDIENTS = 100;
const MAX_INSTRUCTIONS = 60;

function sanitizeIngredients(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const raw of input.slice(0, MAX_INGREDIENTS)) {
    if (typeof raw === 'string') {
      const name = normalizeWhitespace(stripControlChars(raw));
      if (!name) continue;
      out.push({ name: normalizeMealName(name) ?? name });
      continue;
    }

    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const name = normalizeWhitespace(stripControlChars(typeof obj.name === 'string' ? obj.name : ''));
    if (!name) continue;

    const item: Record<string, unknown> = { name: normalizeMealName(name) ?? name };

    const quantity = obj.quantity;
    if (typeof quantity === 'number' && Number.isFinite(quantity)) {
      item.quantity = quantity;
    } else if (typeof quantity === 'string') {
      const parsed = Number(quantity);
      if (Number.isFinite(parsed)) item.quantity = parsed;
    }

    const unit = typeof obj.unit === 'string' ? normalizeWhitespace(stripControlChars(obj.unit)).slice(0, 24) : '';
    if (unit) item.unit = unit;

    const category =
      typeof obj.category === 'string' ? normalizeWhitespace(stripControlChars(obj.category)).slice(0, 40) : '';
    if (category) item.category = category;

    out.push(item);
  }
  return out;
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

    const { id: idRaw } = await params;
    const id = validateRecordId(idRaw);
    if (!id) {
      return new NextResponse("Invalid id", { status: 400 });
    }

    if (isBodyTooLarge(req, 200_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return new NextResponse('Invalid JSON body', { status: 400 });
    }

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
    
    if (name !== undefined) {
      const cleanedName = validateMealName(name);
      if (!cleanedName) return new NextResponse('Invalid name', { status: 400 });
      updateData.name = normalizeMealName(cleanedName) ?? cleanedName;
    }

    if (description !== undefined) {
      if (typeof description !== 'string') return new NextResponse('Invalid description', { status: 400 });
      updateData.description = stripControlChars(description).trim().slice(0, 280);
    }

    if (ingredients !== undefined) {
      if (!Array.isArray(ingredients)) return new NextResponse('Invalid ingredients', { status: 400 });
      updateData.ingredients = sanitizeIngredients(normalizeIngredients(ingredients));
    }

    if (instructions !== undefined) {
      updateData.instructions = sanitizeStringArray(instructions, { maxItems: MAX_INSTRUCTIONS, maxItemLength: 400 });
    }

    if (image !== undefined) {
      if (image == null) {
        updateData.image = null;
      } else if (typeof image === 'string') {
        const cleaned = stripControlChars(image).trim().slice(0, 2048);
        updateData.image = cleaned || null;
      } else {
        return new NextResponse('Invalid image', { status: 400 });
      }
    }

    if (cuisine !== undefined) {
      if (cuisine == null) {
        updateData.cuisine = null;
      } else if (typeof cuisine === 'string') {
        const cleaned = normalizeWhitespace(stripControlChars(cuisine)).slice(0, 60);
        updateData.cuisine = cleaned ? normalizeCuisine(cleaned) ?? cleaned : null;
      } else {
        return new NextResponse('Invalid cuisine', { status: 400 });
      }
    }

    if (rating !== undefined) {
      if (rating == null) {
        updateData.rating = null;
      } else if (typeof rating === 'number' && Number.isFinite(rating)) {
        updateData.rating = Math.max(0, Math.min(5, rating));
      } else {
        return new NextResponse('Invalid rating', { status: 400 });
      }
    }

    if (isFavorite !== undefined) {
      if (typeof isFavorite !== 'boolean') return new NextResponse('Invalid isFavorite', { status: 400 });
      updateData.isFavorite = isFavorite;
    }

    if (userNotes !== undefined) {
      if (userNotes == null) {
        updateData.userNotes = null;
      } else if (typeof userNotes === 'string') {
        const cleaned = stripControlChars(userNotes).trim().slice(0, 2000);
        updateData.userNotes = cleaned || null;
      } else {
        return new NextResponse('Invalid userNotes', { status: 400 });
      }
    }

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

    const res = NextResponse.json({ success: true });
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[MEAL_PUT]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
