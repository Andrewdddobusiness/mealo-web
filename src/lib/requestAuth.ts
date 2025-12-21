import { auth, clerkClient, verifyToken } from "@clerk/nextjs/server";

function getBearerToken(req: Request): string | null {
  const raw = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!raw) return null;
  if (!raw.toLowerCase().startsWith("bearer ")) return null;
  const token = raw.slice(7).trim();
  return token.length ? token : null;
}

function keyType(value: string | undefined): "live" | "test" | "unknown" | "missing" {
  if (!value) return "missing";
  if (value.startsWith("sk_live_") || value.startsWith("pk_live_")) return "live";
  if (value.startsWith("sk_test_") || value.startsWith("pk_test_")) return "test";
  return "unknown";
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64.padEnd(payloadB64.length + ((4 - (payloadB64.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const bearer = getBearerToken(req);

  // Mobile/native clients commonly use `Authorization: Bearer <jwt>`.
  if (bearer) {
    const secretKey = process.env.CLERK_SECRET_KEY;
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!secretKey) {
      console.error("[Auth] CLERK_SECRET_KEY missing while verifying Bearer token");
      return null;
    }

    try {
      const payload = await verifyToken(bearer, { secretKey });
      const sub = payload?.sub;
      return typeof sub === "string" && sub.length ? sub : null;
    } catch (e) {
      // If the Bearer token isn't a JWT Clerk can verify locally (common in native flows),
      // fall back to Clerk's request authentication which can validate other token types.
      const decoded = decodeJwtPayload(bearer);
      console.error("[Auth] verifyToken failed; falling back to authenticateRequest");
      console.error("[Auth] Key types", {
        clerkSecret: keyType(secretKey),
        clerkPublishable: keyType(publishableKey),
        tokenIss: decoded?.iss ?? "n/a",
        tokenAud: decoded?.aud ?? "n/a",
        tokenAzp: decoded?.azp ?? "n/a",
      });
      console.error(e);

      try {
        if (!publishableKey) {
          console.error("[Auth] NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY missing for authenticateRequest");
          return null;
        }

        const client = await clerkClient();
        const requestState = await client.authenticateRequest(req, {
          secretKey,
          publishableKey,
        });
        const authObj = requestState.toAuth();
        return authObj?.userId ?? null;
      } catch (fallbackError) {
        console.error("[Auth] authenticateRequest fallback failed");
        console.error(fallbackError);
        return null;
      }
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
