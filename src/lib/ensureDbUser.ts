import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function fallbackEmail(userId: string): string {
  return `unknown+${userId}@mealo.invalid`;
}

export async function ensureDbUser(
  userId: string,
  hints?: { name?: string; email?: string; avatar?: string },
): Promise<typeof users.$inferSelect> {
  if (!db) {
    throw new Error("Database not configured");
  }

  const existing = await db.select().from(users).where(eq(users.id, userId));
  if (existing.length) return existing[0];

  const client = await clerkClient();
  const clerkUser = await client.users.getUser(userId);

  const name =
    normalizeString(hints?.name) ??
    normalizeString(clerkUser.fullName) ??
    normalizeString([clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ")) ??
    "User";

  const primaryEmail =
    clerkUser.primaryEmailAddress?.emailAddress ??
    clerkUser.emailAddresses?.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    clerkUser.emailAddresses?.[0]?.emailAddress;

  const email = normalizeString(hints?.email) ?? normalizeString(primaryEmail) ?? fallbackEmail(userId);
  const avatar = normalizeString(hints?.avatar) ?? normalizeString(clerkUser.imageUrl);

  const newUser = {
    id: userId,
    name,
    email,
    avatar,
    createdAt: new Date(),
  };

  try {
    await db.insert(users).values(newUser);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // 23505 = unique_violation (e.g., another request inserted first)
    if (code !== "23505") {
      console.warn("[ensureDbUser] insert failed", error);
    }
  }

  const afterInsert = await db.select().from(users).where(eq(users.id, userId));
  if (afterInsert.length) return afterInsert[0];

  throw new Error("Failed to ensure user exists");
}
