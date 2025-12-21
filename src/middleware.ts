import { clerkMiddleware } from "@clerk/nextjs/server";
import type { NextRequest, NextFetchEvent } from "next/server";
import { NextResponse } from "next/server";

const clerkMw = clerkMiddleware((auth, req) => {
  const secretHead = process.env.CLERK_SECRET_KEY?.slice(0, 6) ?? "none";
  const pubHead = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.slice(0, 6) ?? "none";
  console.log(
    `[Middleware] Processing: ${req.url} | Secret=${!!process.env.CLERK_SECRET_KEY} (${secretHead}...) | Pub=${!!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY} (${pubHead}...)`,
  );
});

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const hasSecret = !!process.env.CLERK_SECRET_KEY;
  const hasPublishable = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretLen = process.env.CLERK_SECRET_KEY?.length ?? 0;
  const pubLen = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.length ?? 0;
  const secretHead = process.env.CLERK_SECRET_KEY?.slice(0, 6) ?? "none";
  const pubHead = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.slice(0, 6) ?? "none";
  const isProd =
    process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";

  if (!hasSecret || !hasPublishable) {
    console.error(
      `[Middleware] Missing Clerk envs | Secret=${hasSecret} | Pub=${hasPublishable}`,
    );
    console.error(
      `[Middleware] Env lengths | secretLen=${secretLen} (${secretHead}...) | pubLen=${pubLen} (${pubHead}...) | vercelEnv=${process.env.VERCEL_ENV} | nodeEnv=${process.env.NODE_ENV}`,
    );
    if (isProd) {
      return new NextResponse("Missing Clerk environment variables", { status: 500 });
    }
  }

  try {
    return clerkMw(req, event);
  } catch (e) {
    console.error("[Middleware] Invocation failed:", e);
    return new NextResponse("Middleware invocation failed", { status: 500 });
  }
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
