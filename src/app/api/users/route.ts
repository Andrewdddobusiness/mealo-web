import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/requestAuth";
import { db } from "../../../db";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
      console.error("[USERS_POST] db not configured");
      return new NextResponse("Database not configured", { status: 500 });
    }

    const body = (await req.json()) as Partial<typeof users.$inferInsert>;
    const { id, name, email, avatar } = body;

    if (!id || !name || !email) {
      return new NextResponse("Missing required fields", { status: 400 });
    }

    if (id !== userId) {
      console.error("[USERS_POST] Forbidden: id mismatch", { id, userId });
      return new NextResponse("Forbidden", { status: 403 });
    }

    console.log("[USERS_POST] Auth ok", { userId });

    const existing = await db.select().from(users).where(eq(users.id, id));

    if (existing.length === 0) {
      const newUser = {
        id,
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

