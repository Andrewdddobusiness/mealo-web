import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { recordIngredientUsage } from '@/lib/ingredients';
import { normalizeCuisine, normalizeIngredients, normalizeMealName } from '@/lib/normalizeMeal';
import {
  isBodyTooLarge,
  normalizeWhitespace,
  sanitizeStringArray,
  stripControlChars,
  validateMealDescription,
  validateMealName,
  validateUuid,
} from '@/lib/validation';
import { getMealsColumnAvailability, getMealsSelect, insertMealCompat } from '@/db/compat';
import { autoRecomputeAndPersistMealNutrition } from '@/lib/nutrition/recomputeWorkflow';
import { db } from '../../../db';
import { meals, household_members } from '../../../db/schema';
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

const MAX_INGREDIENTS = 100;
const MAX_INSTRUCTIONS = 60;
const MAX_SOURCE_URL_LENGTH = 2048;

function sanitizeSourceUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = stripControlChars(value).trim();
  if (!trimmed) return null;
  const candidate = trimmed.length > MAX_SOURCE_URL_LENGTH ? trimmed.slice(0, MAX_SOURCE_URL_LENGTH) : trimmed;
  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return candidate;
  } catch {
    return null;
  }
}

function sanitizeIngredientKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = stripControlChars(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 80);
  return normalized;
}

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

    const ingredientKey = sanitizeIngredientKey(obj.ingredientKey);
    if (ingredientKey) item.ingredientKey = ingredientKey;

    const ingredientCatalogId = validateUuid(obj.ingredientCatalogId) ?? '';
    if (ingredientCatalogId) item.ingredientCatalogId = ingredientCatalogId;

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

export async function GET(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const mealsColumns = await getMealsColumnAvailability(db);
    const nutritionSelect = mealsColumns.nutrition ? sql`m.nutrition AS "nutrition",` : sql`NULL::jsonb AS "nutrition",`;
    const sourceUrlSelect = mealsColumns.sourceUrl ? sql`m.source_url AS "sourceUrl",` : sql`NULL::text AS "sourceUrl",`;

    // Fetch all meals in households the user belongs to, in one round trip.
    // Note: We alias snake_case DB columns to the camelCase shape used by the mobile app.
    const mealsResult = await db.execute(sql`
      SELECT
        m.id,
        m.household_id AS "householdId",
        m.name,
        m.description,
        m.created_by AS "createdBy",
        m.ingredients,
        m.instructions,
        ${nutritionSelect}
        m.from_global_meal_id AS "fromGlobalMealId",
        ${sourceUrlSelect}
        m.rating,
        m.is_favorite AS "isFavorite",
        m.user_notes AS "userNotes",
        m.image,
        m.cuisine,
        m.created_at AS "createdAt"
      FROM meals m
      WHERE m.household_id IN (
        SELECT household_id
        FROM household_members
        WHERE user_id = ${userId}
      );
    `);

    // 3. Format for client
    const formattedMeals = (mealsResult.rows ?? []).map((m) => ({
      ...m,
      ingredients: (m as any).ingredients,
      instructions: (m as any).instructions,
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

    const mealsSelect = await getMealsSelect(db);
    const mealsColumns = await getMealsColumnAvailability(db);

    if (isBodyTooLarge(req, 200_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return new NextResponse('Invalid JSON body', { status: 400 });
    }

    const householdId = validateUuid((body as any)?.householdId) ?? '';
    const nameBase = validateMealName((body as any)?.name);
    const name = nameBase ? normalizeMealName(nameBase) ?? nameBase : '';
    const fromGlobalMealId = validateUuid((body as any)?.fromGlobalMealId);
    const normalizedIngredients = sanitizeIngredients(normalizeIngredients((body as any)?.ingredients));
    const normalizedCuisineRaw =
      typeof (body as any)?.cuisine === 'string'
        ? normalizeWhitespace(stripControlChars((body as any).cuisine)).slice(0, 60)
        : '';
    const normalizedCuisine = normalizedCuisineRaw ? normalizeCuisine(normalizedCuisineRaw) ?? normalizedCuisineRaw : undefined;

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
        .select(mealsSelect)
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
        .select(mealsSelect)
        .from(meals)
        .where(
          and(
            eq(meals.householdId, householdId),
            eq(meals.createdBy, userId),
            isNull(meals.fromGlobalMealId),
            sql`lower(${meals.name}) = ${name.toLowerCase()}`,
          ),
        );

      const bodyKey = canonicalIngredientsKey(normalizedIngredients);
      const match = candidates.find((m) => canonicalIngredientsKey(m.ingredients) === bodyKey);
      if (match) {
        return NextResponse.json({
          ...match,
          ingredients: match.ingredients,
          instructions: match.instructions,
        });
      }
    }
    
    const id = validateUuid((body as any)?.id) ?? uuidv4();

    const description = validateMealDescription((body as any)?.description);
    const userNotesRaw = typeof (body as any)?.userNotes === 'string' ? stripControlChars((body as any).userNotes).trim() : '';
    const userNotes = userNotesRaw ? userNotesRaw.slice(0, 2000) : undefined;
    const imageRaw = typeof (body as any)?.image === 'string' ? stripControlChars((body as any).image).trim() : '';
    const image = imageRaw ? imageRaw.slice(0, 2048) : undefined;
    const ratingRaw = (body as any)?.rating;
    const rating = typeof ratingRaw === 'number' && Number.isFinite(ratingRaw) ? Math.max(0, Math.min(5, ratingRaw)) : undefined;
    const instructions = sanitizeStringArray((body as any)?.instructions, { maxItems: MAX_INSTRUCTIONS, maxItemLength: 400 });
    const sourceUrlInput = sanitizeSourceUrl((body as any)?.sourceUrl);
    if ((body as any)?.sourceUrl !== undefined && sourceUrlInput === undefined) {
      return new NextResponse('Invalid sourceUrl', { status: 400 });
    }

    const newMeal: typeof meals.$inferInsert = {
      id,
      householdId,
      name,
      description,
      ingredients: normalizedIngredients,
      instructions,
      fromGlobalMealId,
      sourceUrl: mealsColumns.sourceUrl ? sourceUrlInput : undefined,
      rating,
      isFavorite: typeof (body as any)?.isFavorite === 'boolean' ? (body as any).isFavorite : undefined,
      userNotes,
      image,
      cuisine: normalizedCuisine,
      createdBy: userId, // Enforce creator
      createdAt: new Date(),
    };

    await insertMealCompat(db, newMeal);

    try {
      await recordIngredientUsage(db, userId, newMeal.ingredients);
    } catch (error) {
      console.error('[MEALS_POST_INGREDIENT_USAGE]', error);
    }

    await autoRecomputeAndPersistMealNutrition({
      db,
      mealId: id,
      mealName: newMeal.name,
      ingredients: newMeal.ingredients,
      loggerTag: 'MEALS_POST_NUTRITION',
    });

    const createdRows = await db.select(mealsSelect).from(meals).where(eq(meals.id, id)).limit(1);
    const createdMeal = createdRows[0];
    const payload = createdMeal
      ? {
          ...createdMeal,
          ingredients: createdMeal.ingredients,
          instructions: createdMeal.instructions,
        }
      : newMeal;

    const res = NextResponse.json(payload);
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[MEALS_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
