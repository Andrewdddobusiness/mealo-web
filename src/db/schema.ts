import { pgTable, text, timestamp, integer, boolean, jsonb, index } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  avatar: text('avatar'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const households = pgTable(
  'households',
  {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').notNull(),
  createdBy: text('created_by').references(() => users.id),
  memberIds: jsonb('member_ids').default([]),
  currentPeriodStart: text('current_period_start'),
  currentPeriodEnd: text('current_period_end'),
  shoppingList: jsonb('shopping_list').default([]),
  currency: text('currency').default('USD'),
  createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    ownerIdx: index('households_owner_id_idx').on(table.ownerId),
  }),
);

export const meals = pgTable(
  'meals',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id').references(() => households.id).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdBy: text('created_by').references(() => users.id),
    ingredients: jsonb('ingredients').default([]),
    instructions: jsonb('instructions').default([]),
    fromGlobalMealId: text('from_global_meal_id'),
    rating: integer('rating').default(0),
    isFavorite: boolean('is_favorite').default(false),
    userNotes: text('user_notes'),
    image: text('image'),
    cuisine: text('cuisine'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    householdIdx: index('meals_household_id_idx').on(table.householdId),
    fromGlobalIdx: index('meals_from_global_meal_id_idx').on(table.fromGlobalMealId),
  }),
);

export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id').references(() => households.id).notNull(),
    mealId: text('meal_id').references(() => meals.id).notNull(),
    date: text('date').notNull(),
    isCompleted: boolean('is_completed').default(false),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    householdIdx: index('plans_household_id_idx').on(table.householdId),
    mealIdx: index('plans_meal_id_idx').on(table.mealId),
  }),
);

export const globalMeals = pgTable('global_meals', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  ingredients: jsonb('ingredients').default([]),
  instructions: jsonb('instructions').default([]),
  image: text('image'),
  cuisine: text('cuisine'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const household_members = pgTable(
  'household_members',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id').references(() => households.id, { onDelete: 'cascade' }).notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    role: text('role').notNull(), // "owner" | "member"
    joinedAt: timestamp('joined_at').defaultNow(),
  },
  (table) => ({
    householdIdx: index('household_members_household_id_idx').on(table.householdId),
    userIdx: index('household_members_user_id_idx').on(table.userId),
    userHouseholdIdx: index('household_members_user_id_household_id_idx').on(table.userId, table.householdId),
  }),
);

export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  householdId: text('household_id').references(() => households.id, { onDelete: 'cascade' }).notNull(),
  token: text('token').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usesLeft: integer('uses_left'),
  createdBy: text('created_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  tokenIdx: index('invites_token_idx').on(table.token),
}));

export const subscriptions = pgTable('subscriptions', {
  userId: text('user_id').references(() => users.id).primaryKey(),
  originalTransactionId: text('original_transaction_id').notNull(),
  productId: text('product_id').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  isTrial: boolean('is_trial').default(false),
  isActive: boolean('is_active').default(true),
  autoRenewStatus: boolean('auto_renew_status').default(true),
  updatedAt: timestamp('updated_at').defaultNow(),
});
