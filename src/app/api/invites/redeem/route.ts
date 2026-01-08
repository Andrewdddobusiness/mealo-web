import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../db';
import { invites, household_members, households } from '../../../../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { isBodyTooLarge, validateInviteToken } from '@/lib/validation';

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_PER_IP = 30;
const RATE_LIMIT_MAX_PER_USER = 10;
const rateLimitByIp = new Map<string, { resetAtMs: number; count: number }>();
const rateLimitByUser = new Map<string, { resetAtMs: number; count: number }>();

function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || 'unknown';
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

function checkRateLimit(map: Map<string, { resetAtMs: number; count: number }>, key: string, max: number) {
  const nowMs = Date.now();
  const existing = map.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    map.set(key, { resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS, count: 1 });
    return { allowed: true as const };
  }
  if (existing.count >= max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
    return { allowed: false as const, retryAfterSeconds };
  }
  existing.count += 1;
  map.set(key, existing);
  return { allowed: true as const };
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const ip = getClientIp(req);
    const ipLimit = checkRateLimit(rateLimitByIp, ip, RATE_LIMIT_MAX_PER_IP);
    if (!ipLimit.allowed) {
      const res = new NextResponse('Too many requests. Please try again later.', { status: 429 });
      res.headers.set('retry-after', String(ipLimit.retryAfterSeconds));
      return res;
    }

    const userLimit = checkRateLimit(rateLimitByUser, userId, RATE_LIMIT_MAX_PER_USER);
    if (!userLimit.allowed) {
      const res = new NextResponse('Too many requests. Please try again later.', { status: 429 });
      res.headers.set('retry-after', String(userLimit.retryAfterSeconds));
      return res;
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    if (isBodyTooLarge(req, 10_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const body = await req.json().catch(() => null);
    const token = validateInviteToken((body as any)?.token);
    if (!token) {
      return new NextResponse('Invalid token', { status: 400 });
    }

    // 1. Find invite
    const invite = await db.select().from(invites).where(eq(invites.token, token)).limit(1);
    if (invite.length === 0) {
        return new NextResponse("This link is invalid", { status: 404 });
    }
    
    const inv = invite[0];
    if (new Date() > inv.expiresAt) {
        return new NextResponse("Invite link has expired", { status: 410 });
    }
    if (inv.usesLeft !== null && inv.usesLeft <= 0) {
        return new NextResponse("Invite link has expired", { status: 410 });
    }

    // 2. Check if household exists
    const householdExists = await db.select().from(households).where(eq(households.id, inv.householdId)).limit(1);
    if (householdExists.length === 0) {
        return new NextResponse("Group no longer exists", { status: 404 });
    }

    // 3. Check if user is already a member
    const existingMember = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, inv.householdId),
            eq(household_members.userId, userId)
        )
    );

    if (existingMember.length > 0) {
        return new NextResponse("You are already a member of this group", { status: 409 });
    }

    // 4. Add member
    await db.insert(household_members).values({
        id: uuidv4(),
        householdId: inv.householdId,
        userId: userId,
        role: 'member',
        joinedAt: new Date()
    });

    // 5. Decrement uses
    if (inv.usesLeft !== null) {
        await db.update(invites).set({ usesLeft: inv.usesLeft - 1 }).where(eq(invites.id, inv.id));
    }

    const res = NextResponse.json({ success: true, householdId: inv.householdId });
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[INVITES_REDEEM_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
