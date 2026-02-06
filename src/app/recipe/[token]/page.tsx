/* eslint-disable react/no-unescaped-entities */
import { db } from '@/db';
import { mealShares, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { headers } from 'next/headers';
import { Download, Smartphone } from 'lucide-react';

interface Props {
  params: Promise<{ token: string }>;
}

type SnapshotPreview = {
  name: string;
  description: string | null;
  image: string | null;
  cuisine: string | null;
};

function parseSnapshot(raw: unknown): SnapshotPreview {
  const snapshot = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

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

export default async function RecipeSharePage({ params }: Props) {
  const { token } = await params;

  const deepLink = `mealo://recipe/${encodeURIComponent(token)}`;

  const hdrs = await headers();
  const ua = hdrs.get('user-agent') ?? '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  const appStoreUrl =
    process.env.NEXT_PUBLIC_APP_STORE_URL ?? 'https://apps.apple.com/au/app/mealo-meal-planner/id6756686048';
  const playStoreUrl =
    process.env.NEXT_PUBLIC_PLAY_STORE_URL ??
    'https://play.google.com/store/apps/details?id=com.mealo.app';

  const primaryDownloadUrl = isAndroid ? playStoreUrl : appStoreUrl;

  let isInvalid = false;
  let isExpired = false;
  let preview: SnapshotPreview | null = null;
  let sharedByName: string | null = null;

  if (db) {
    const shareRows = await db
      .select({
        snapshot: mealShares.snapshot,
        expiresAt: mealShares.expiresAt,
        revokedAt: mealShares.revokedAt,
        sharedByName: users.name,
      })
      .from(mealShares)
      .innerJoin(users, eq(mealShares.createdBy, users.id))
      .where(eq(mealShares.token, token))
      .limit(1);

    if (!shareRows.length) {
      isInvalid = true;
    } else {
      const share = shareRows[0];
      preview = parseSnapshot(share.snapshot);
      sharedByName = share.sharedByName;
      isExpired = Boolean(share.revokedAt) || Boolean(share.expiresAt && new Date() > share.expiresAt);
      if (!preview?.name) {
        isInvalid = true;
      }
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-background to-muted/20 p-4 text-center">
      <div className="w-full max-w-md space-y-8 rounded-3xl border border-border/50 bg-card p-8 shadow-2xl">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">
            {isInvalid ? 'Recipe link not found' : 'Recipe shared with you'}
          </h1>
          {isInvalid ? (
            <p className="text-muted-foreground">
              This recipe link looks invalid. Ask your friend to generate a new share link.
            </p>
          ) : (
            <p className="text-muted-foreground">
              {sharedByName ? (
                <>
                  <span className="font-semibold text-foreground">{sharedByName}</span> shared a recipe with you on Mealo.
                </>
              ) : (
                <>Open Mealo to accept this recipe and add it to your meal library.</>
              )}
            </p>
          )}
        </div>

        {!isInvalid && preview?.image ? (
          <div className="overflow-hidden rounded-2xl border border-border/50 bg-muted/20">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.image} alt={preview.name || 'Shared recipe'} className="h-52 w-full object-cover" />
            <div className="space-y-1 p-4 text-left">
              <p className="font-semibold text-foreground">{preview.name}</p>
              {preview.cuisine ? <p className="text-sm text-muted-foreground">{preview.cuisine}</p> : null}
              {preview.description ? <p className="text-sm text-muted-foreground">{preview.description}</p> : null}
            </div>
          </div>
        ) : null}

        {isExpired ? (
          <div className="rounded-xl bg-destructive/10 p-4 text-destructive">
            This recipe link has expired. Ask for a fresh share link.
          </div>
        ) : (
          <div className="space-y-4">
            <Button size="lg" className="h-14 w-full gap-2 text-lg" asChild>
              <a href={deepLink}>
                <Smartphone className="h-5 w-5" />
                Open in Mealo App
              </a>
            </Button>

            <div className="flex items-center gap-4">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase text-muted-foreground">Don't have the app?</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <Button variant="outline" size="lg" className="w-full gap-2" asChild>
              <Link href={primaryDownloadUrl}>
                <Download className="h-4 w-4" />
                {isIOS ? 'Download on App Store' : isAndroid ? 'Get it on Google Play' : 'Download Mealo'}
              </Link>
            </Button>

            {!isAndroid && !isIOS && (
              <div className="grid grid-cols-1 gap-3 pt-2">
                <Button variant="ghost" size="sm" className="w-full" asChild>
                  <Link href={appStoreUrl}>App Store</Link>
                </Button>
                <Button variant="ghost" size="sm" className="w-full" asChild>
                  <Link href={playStoreUrl}>Google Play</Link>
                </Button>
              </div>
            )}

            {!db && process.env.NODE_ENV === 'development' && (
              <div className="rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">
                Recipe details are hidden because <span className="font-mono">DATABASE_URL</span> is not set for this
                web app. The token will still be redeemable inside the Mealo app.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
