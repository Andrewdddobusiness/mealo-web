import { NextResponse } from 'next/server';
import { db } from '@/db';
import { mealShares, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { validateShareToken } from '@/lib/validation';

type ShareSnapshot = {
  name?: unknown;
  description?: unknown;
  image?: unknown;
  cuisine?: unknown;
};

function getPreview(snapshotRaw: unknown) {
  const snapshot = (snapshotRaw && typeof snapshotRaw === 'object' ? snapshotRaw : {}) as ShareSnapshot;

  const name = typeof snapshot.name === 'string' ? snapshot.name.trim() : '';
  const descriptionRaw = typeof snapshot.description === 'string' ? snapshot.description.trim() : '';
  const imageRaw = typeof snapshot.image === 'string' ? snapshot.image.trim() : '';
  const cuisineRaw = typeof snapshot.cuisine === 'string' ? snapshot.cuisine.trim() : '';

  return {
    name,
    description: descriptionRaw ? descriptionRaw.slice(0, 180) : null,
    image: imageRaw || null,
    cuisine: cuisineRaw || null,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    if (!db) {
      return new NextResponse('Database not configured', { status: 500 });
    }

    const { token: tokenRaw } = await params;
    const token = validateShareToken(tokenRaw);
    if (!token) {
      return new NextResponse('Invalid token', { status: 400 });
    }

    const rows = await db
      .select({
        id: mealShares.id,
        token: mealShares.token,
        snapshot: mealShares.snapshot,
        expiresAt: mealShares.expiresAt,
        revokedAt: mealShares.revokedAt,
        createdAt: mealShares.createdAt,
        sharedByName: users.name,
      })
      .from(mealShares)
      .innerJoin(users, eq(mealShares.createdBy, users.id))
      .where(eq(mealShares.token, token))
      .limit(1);

    if (rows.length === 0) {
      return new NextResponse('Recipe share not found', { status: 404 });
    }

    const share = rows[0];
    if (share.revokedAt) {
      return new NextResponse('Recipe share was revoked', { status: 410 });
    }
    if (share.expiresAt && new Date() > share.expiresAt) {
      return new NextResponse('Recipe share has expired', { status: 410 });
    }

    const preview = getPreview(share.snapshot);
    if (!preview.name) {
      return new NextResponse('Recipe share not found', { status: 404 });
    }

    const res = NextResponse.json({
      token: share.token,
      name: preview.name,
      description: preview.description,
      image: preview.image,
      cuisine: preview.cuisine,
      sharedByName: share.sharedByName,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
    });
    res.headers.set('cache-control', 'no-store');
    return res;
  } catch (error) {
    console.error('[RECIPE_SHARE_GET]', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
