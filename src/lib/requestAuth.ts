import { auth, verifyToken } from "@clerk/nextjs/server";

function getBearerToken(req: Request): string | null {
  const raw = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!raw) return null;
  if (!raw.toLowerCase().startsWith("bearer ")) return null;
  const token = raw.slice(7).trim();
  return token.length ? token : null;
}

export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const bearer = getBearerToken(req);

  // Mobile/native clients commonly use `Authorization: Bearer <jwt>`.
  if (bearer) {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      console.error("[Auth] CLERK_SECRET_KEY missing while verifying Bearer token");
      return null;
    }

    try {
      const payload = await verifyToken(bearer, { secretKey });
      const sub = payload?.sub;
      return typeof sub === "string" && sub.length ? sub : null;
    } catch (e) {
      console.error("[Auth] verifyToken failed");
      console.error(e);
      return null;
    }
  }

  // Browser clients use Clerk cookies; fall back to Clerk's Next helper.
  try {
    const { userId } = await auth();
    return userId ?? null;
  } catch (e) {
    console.error("[Auth] auth() failed");
    console.error(e);
    return null;
  }
}

