import { sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from './schema';
import { meals } from './schema';

type MealsColumnAvailability = {
  nutrition: boolean;
  sourceUrl: boolean;
};

let cachedMealsColumns: MealsColumnAvailability | null = null;

export async function getMealsColumnAvailability(db: NeonHttpDatabase<typeof schema>): Promise<MealsColumnAvailability> {
  if (cachedMealsColumns) return cachedMealsColumns;

  try {
    const result = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'meals'
        AND column_name IN ('nutrition', 'source_url')
    `);

    const names = new Set(
      (result.rows ?? [])
        .map((row) => (row as { column_name?: unknown }).column_name)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );

    cachedMealsColumns = {
      nutrition: names.has('nutrition'),
      sourceUrl: names.has('source_url'),
    };
  } catch {
    cachedMealsColumns = { nutrition: false, sourceUrl: false };
  }

  return cachedMealsColumns;
}

export async function hasMealsNutritionColumn(db: NeonHttpDatabase<typeof schema>): Promise<boolean> {
  return (await getMealsColumnAvailability(db)).nutrition;
}

export async function hasMealsSourceUrlColumn(db: NeonHttpDatabase<typeof schema>): Promise<boolean> {
  return (await getMealsColumnAvailability(db)).sourceUrl;
}

export async function getMealsSelect(db: NeonHttpDatabase<typeof schema>) {
  const availability = await getMealsColumnAvailability(db);

  return {
    id: meals.id,
    householdId: meals.householdId,
    name: meals.name,
    description: meals.description,
    createdBy: meals.createdBy,
    ingredients: meals.ingredients,
    instructions: meals.instructions,
    nutrition: availability.nutrition ? meals.nutrition : sql`NULL::jsonb`,
    fromGlobalMealId: meals.fromGlobalMealId,
    sourceUrl: availability.sourceUrl ? meals.sourceUrl : sql`NULL::text`,
    rating: meals.rating,
    isFavorite: meals.isFavorite,
    userNotes: meals.userNotes,
    image: meals.image,
    cuisine: meals.cuisine,
    createdAt: meals.createdAt,
  };
}

