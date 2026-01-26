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

export async function insertMealCompat(
  db: NeonHttpDatabase<typeof schema>,
  meal: typeof meals.$inferInsert,
): Promise<void> {
  const availability = await getMealsColumnAvailability(db);

  const columns: string[] = [];
  const values: unknown[] = [];

  function push(column: string, value: unknown) {
    if (value === undefined) return;
    columns.push(column);
    values.push(value);
  }

  push('id', meal.id);
  push('household_id', meal.householdId);
  push('name', meal.name);
  push('description', meal.description);
  push('created_by', meal.createdBy);
  push('ingredients', meal.ingredients);
  push('instructions', meal.instructions);

  if (availability.nutrition) {
    push('nutrition', (meal as any).nutrition);
  }

  push('from_global_meal_id', meal.fromGlobalMealId);

  if (availability.sourceUrl) {
    push('source_url', meal.sourceUrl);
  }

  push('rating', meal.rating);
  push('is_favorite', meal.isFavorite);
  push('user_notes', meal.userNotes);
  push('image', meal.image);
  push('cuisine', meal.cuisine);
  push('created_at', meal.createdAt);

  if (columns.length === 0) {
    throw new Error('insertMealCompat: no values provided');
  }

  await db.execute(sql`
    INSERT INTO ${sql.identifier('meals')}
    (${sql.join(columns.map((c) => sql.identifier(c)), sql`, `)})
    VALUES (${sql.join(values.map((v) => sql.param(v)), sql`, `)})
  `);
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
