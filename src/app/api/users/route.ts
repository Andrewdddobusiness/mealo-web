import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/requestAuth";
import { clerkClient } from "@clerk/nextjs/server";
import { db } from "../../../db";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { isBodyTooLarge, stripControlChars } from "@/lib/validation";

function normalizeString(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = stripControlChars(value).trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
      const bearer = authHeader?.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : null;
      const dotCount = bearer ? (bearer.match(/\./g) || []).length : 0;

      if (process.env.NODE_ENV !== "production") {
        console.error("[USERS_POST] Unauthorized", {
          hasAuthHeader: !!authHeader,
          bearerLike: !!bearer,
          tokenDots: dotCount,
        });
      } else {
        console.error("[USERS_POST] Unauthorized");
      }

      const reason = !authHeader ? "missing_authorization" : !bearer ? "not_bearer" : "invalid_token";
      return new NextResponse(`Unauthorized (${reason})`, { status: 401 });
    }

    if (!db) {
      console.error("[USERS_POST] db not configured");
      return new NextResponse("Database not configured", { status: 500 });
    }

    if (isBodyTooLarge(req, 25_000)) {
      return new NextResponse("Payload too large", { status: 413 });
    }

    const body = (await req.json()) as Partial<typeof users.$inferInsert>;
    const requestedId = normalizeString(body.id, 128);
    const effectiveId = requestedId ?? userId;

    if (effectiveId !== userId) {
      if (process.env.NODE_ENV !== "production") {
        console.error("[USERS_POST] Forbidden: id mismatch", { requestedId, userId });
      } else {
        console.error("[USERS_POST] Forbidden: id mismatch");
      }
      return new NextResponse("Forbidden", { status: 403 });
    }

    let name = normalizeString(body.name, 120);
    let email = normalizeString(body.email, 320);
    let avatar = normalizeString(body.avatar, 2048);

    if (!name || !email) {
      const client = await clerkClient();
      const clerkUser = await client.users.getUser(userId);

      name =
        name ??
        normalizeString(clerkUser.fullName, 120) ??
        normalizeString([clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" "), 120) ??
        "User";

      const primaryEmail =
        clerkUser.primaryEmailAddress?.emailAddress ??
        clerkUser.emailAddresses?.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
        clerkUser.emailAddresses?.[0]?.emailAddress;

      email = email ?? normalizeString(primaryEmail, 320);
      avatar = avatar ?? normalizeString(clerkUser.imageUrl, 2048);
    }

    if (!email) {
      console.error("[USERS_POST] Missing email for user", { userId });
      return new NextResponse("Missing required fields (email)", { status: 400 });
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("[USERS_POST] Auth ok", { userId });
    }

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
