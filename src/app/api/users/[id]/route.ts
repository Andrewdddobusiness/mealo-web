import { NextResponse } from 'next/server';
import { getUserIdFromRequest } from '@/lib/requestAuth';
import { db } from '../../../../db';
import { users } from '../../../../db/schema';
import { eq } from 'drizzle-orm';
import { isBodyTooLarge, stripControlChars } from '@/lib/validation';

const ONBOARDING_GOALS = new Set(['plan_meals', 'eat_healthier', 'save_time', 'save_money', 'family_meals', 'other']);
const ONBOARDING_FOOD_PREFERENCES = new Set(['flexible', 'vegetarian', 'vegan', 'pescatarian', 'other']);
const ONBOARDING_COOKING_SKILLS = new Set(['novice', 'beginner', 'intermediate', 'advanced']);
const ONBOARDING_PANTRY_LEVELS = new Set(['basic', 'average', 'well_stocked']);

function normalizeEnum(value: unknown, allowed: Set<string>, maxLen: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = stripControlChars(value).trim().slice(0, maxLen);
  if (!cleaned) return undefined;
  return allowed.has(cleaned) ? cleaned : undefined;
}

function normalizeStringArray(value: unknown, opts: { maxItems: number; maxItemLen: number }): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const cleaned = stripControlChars(item).trim().slice(0, opts.maxItemLen);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= opts.maxItems) break;
  }
  return out;
}

function normalizeOnboardingProfile(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const raw = value as any;
  const out: Record<string, unknown> = {};

  if ('goal' in raw) {
    out.goal = normalizeEnum(raw.goal, ONBOARDING_GOALS, 24) ?? null;
  }
  if ('foodPreference' in raw) {
    out.foodPreference = normalizeEnum(raw.foodPreference, ONBOARDING_FOOD_PREFERENCES, 24) ?? null;
  }
  if ('cookingSkill' in raw) {
    out.cookingSkill = normalizeEnum(raw.cookingSkill, ONBOARDING_COOKING_SKILLS, 24) ?? null;
  }
  if ('pantryLevel' in raw) {
    out.pantryLevel = normalizeEnum(raw.pantryLevel, ONBOARDING_PANTRY_LEVELS, 24) ?? null;
  }

  if ('allergies' in raw) {
    out.allergies = normalizeStringArray(raw.allergies, { maxItems: 80, maxItemLen: 80 });
  }
  if ('dislikes' in raw) {
    out.dislikes = normalizeStringArray(raw.dislikes, { maxItems: 80, maxItemLen: 80 });
  }
  if ('cuisinesLiked' in raw) {
    out.cuisinesLiked = normalizeStringArray(raw.cuisinesLiked, { maxItems: 80, maxItemLen: 80 });
  }
  if ('cuisinesDisliked' in raw) {
    out.cuisinesDisliked = normalizeStringArray(raw.cuisinesDisliked, { maxItems: 80, maxItemLen: 80 });
  }

  return out;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getUserIdFromRequest(req);
    if (!userId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    if (!db) {
        return new NextResponse("Database not configured", { status: 500 });
    }

    const { id } = await params;

    // Privacy: limit this endpoint to self. Household membership lookups should go through
    // /api/households/:id/members which is already membership-gated.
    if (id !== userId) {
      return new NextResponse("Forbidden", { status: 403 });
    }
    
    const user = await db.select().from(users).where(eq(users.id, id)).limit(1);
    
    if (user.length === 0) {
        return new NextResponse("User not found", { status: 404 });
    }

    const res = NextResponse.json(user[0]);
    res.headers.set('cache-control', 'no-store');
    return res;

  } catch (error) {
    console.error('[USER_GET]', error);
    return new NextResponse("Internal Error", { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getUserIdFromRequest(req);
        if (!userId) {
          return new NextResponse("Unauthorized", { status: 401 });
        }
    
        if (!db) {
            return new NextResponse("Database not configured", { status: 500 });
        }
    
        const { id } = await params;
        if (isBodyTooLarge(req, 25_000)) {
          return new NextResponse('Payload too large', { status: 413 });
        }

        const body = await req.json().catch(() => null);
        if (!body || typeof body !== 'object') {
          return new NextResponse('Invalid JSON body', { status: 400 });
        }

        if (id !== userId) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        const { name, email, avatar, onboardingProfile } = body as Partial<typeof users.$inferInsert> & {
          onboardingProfile?: unknown;
        };
        const updateData: Partial<typeof users.$inferInsert> = {};
        if (name !== undefined) {
          if (typeof name !== 'string') return new NextResponse('Invalid name', { status: 400 });
          const cleaned = stripControlChars(name).trim().slice(0, 120);
          if (!cleaned) return new NextResponse('Invalid name', { status: 400 });
          updateData.name = cleaned;
        }
        if (email !== undefined) {
          if (typeof email !== 'string') return new NextResponse('Invalid email', { status: 400 });
          const cleaned = stripControlChars(email).trim().slice(0, 320);
          if (!cleaned) return new NextResponse('Invalid email', { status: 400 });
          updateData.email = cleaned;
        }
        if (avatar !== undefined) {
          if (avatar == null) {
            updateData.avatar = null;
          } else if (typeof avatar === 'string') {
            const cleaned = stripControlChars(avatar).trim().slice(0, 2048);
            updateData.avatar = cleaned || null;
          } else {
            return new NextResponse('Invalid avatar', { status: 400 });
          }
        }

        if (onboardingProfile !== undefined) {
          const normalized = normalizeOnboardingProfile(onboardingProfile);
          if (normalized === undefined) {
            return new NextResponse('Invalid onboardingProfile', { status: 400 });
          }
          updateData.onboardingProfile = normalized;
        }

        if (Object.keys(updateData).length === 0) {
            return new NextResponse("No valid fields to update", { status: 400 });
        }

        await db.update(users).set(updateData).where(eq(users.id, id));
        
        const updatedUser = await db.select().from(users).where(eq(users.id, id));

        const res = NextResponse.json(updatedUser[0]);
        res.headers.set('cache-control', 'no-store');
        return res;
    
      } catch (error) {
        console.error('[USER_PUT]', error);
        return new NextResponse("Internal Error", { status: 500 });
      }
}
