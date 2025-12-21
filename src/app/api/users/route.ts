import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/requestAuth";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "../../../db";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
      const bearer = authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null;
      const dotCount = bearer ? (bearer.match(/\./g) || []).length : 0;

      console.error("[USERS_POST] Unauthorized", {
        hasAuthHeader: !!authHeader,
        bearerLike: !!bearer,
        tokenDots: dotCount,
      });

      const reason = !authHeader ? "missing_authorization" : !bearer ? "not_bearer" : "invalid_token";
      return new NextResponse(`Unauthorized (${reason})`, { status: 401 });
    }

    if (!db) {
      console.error("[USERS_POST] db not configured");
      return new NextResponse("Database not configured", { status: 500 });
    }

    const body = (await req.json()) as Partial<typeof users.$inferInsert>;
    const requestedId = normalizeString(body.id);
    const effectiveId = requestedId ?? userId;

    if (effectiveId !== userId) {
      console.error("[USERS_POST] Forbidden: id mismatch", { requestedId, userId });
      return new NextResponse("Forbidden", { status: 403 });
    }

    let name = normalizeString(body.name);
    let email = normalizeString(body.email);
    let avatar = normalizeString(body.avatar);

    if (!name || !email) {
      const client = await clerkClient();
      const clerkUser = await client.users.getUser(userId);

      name =
        name ??
        normalizeString(clerkUser.fullName) ??
        normalizeString([clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ")) ??
        "User";

      const primaryEmail =
        clerkUser.primaryEmailAddress?.emailAddress ??
        clerkUser.emailAddresses?.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
        clerkUser.emailAddresses?.[0]?.emailAddress;

      email = email ?? normalizeString(primaryEmail);
      avatar = avatar ?? normalizeString(clerkUser.imageUrl);
    }

    if (!email) {
      console.error("[USERS_POST] Missing email for user", { userId });
      return new NextResponse("Missing required fields (email)", { status: 400 });
    }

    console.log("[USERS_POST] Auth ok", { userId });

    const existing = await db.select().from(users).where(eq(users.id, effectiveId));

    if (existing.length === 0) {
      const newUser = {
        id: effectiveId,
        name,
        email,
        avatar,
        createdAt: new Date(),
      };
      await db.insert(users).values(newUser);
      return NextResponse.json(newUser);
    }

    return NextResponse.json(existing[0]);
  } catch (error) {
    console.error("[USERS_POST]", error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
