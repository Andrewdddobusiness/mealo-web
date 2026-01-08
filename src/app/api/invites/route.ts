import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../db';
import { invites, household_members } from '../../../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { addDays } from 'date-fns';
import { isBodyTooLarge, validateUuid } from '@/lib/validation';

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX_PER_USER = 30;
const rateLimitByUser = new Map<string, { resetAtMs: number; count: number }>();

function checkRateLimit(userId: string) {
  const nowMs = Date.now();
  const existing = rateLimitByUser.get(userId);
  if (!existing || existing.resetAtMs <= nowMs) {
    rateLimitByUser.set(userId, { resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS, count: 1 });
    return { allowed: true as const };
  }
  if (existing.count >= RATE_LIMIT_MAX_PER_USER) {
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
    return { allowed: false as const, retryAfterSeconds };
  }
  existing.count += 1;
  rateLimitByUser.set(userId, existing);
  return { allowed: true as const };
}

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const limit = checkRateLimit(userId);
    if (!limit.allowed) {
      const res = new NextResponse('Too many requests. Please try again later.', { status: 429 });
      res.headers.set('retry-after', String(limit.retryAfterSeconds));
      return res;
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    if (isBodyTooLarge(req, 10_000)) {
      return new NextResponse('Payload too large', { status: 413 });
    }

    const body = await req.json().catch(() => null);
    const householdId = validateUuid((body as any)?.householdId);
    if (!householdId) {
      return new NextResponse('Invalid householdId', { status: 400 });
    }

    // Verify user is a member (or owner?) of the household
    // Ideally only owners can invite? The original code didn't strictly enforce owner for creating invites, 
    // but `removeMember` did. Let's enforce membership at least.
    const userMembership = await db.select().from(household_members).where(
        and(
            eq(household_members.householdId, householdId),
            eq(household_members.userId, userId)
        )
    );

    if (userMembership.length === 0) {
         return new NextResponse("You are not a member of this household", { status: 403 });
    }

    const token = uuidv4();
    const expiresAt = addDays(new Date(), 2); // 48 hours

    const newInvite = {
        id: uuidv4(),
        householdId,
        token,
        expiresAt,
        usesLeft: null, // null = multi-use
        createdBy: userId,
        createdAt: new Date()
    };

    await db.insert(invites).values(newInvite);

    const webUrl = process.env.EXPO_PUBLIC_WEB_APP_URL || 'https://mealo.website';
    const inviteUrl = `${webUrl}/invite/${token}`;

    const res = NextResponse.json({ inviteUrl, expiresAt });
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[INVITES_POST]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}
