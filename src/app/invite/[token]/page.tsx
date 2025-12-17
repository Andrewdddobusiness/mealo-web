import { db } from '@/db';
import { invites, households, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { headers } from 'next/headers';
import { Smartphone, Download } from 'lucide-react';

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;

  const deepLink = `mealo://invite?token=${encodeURIComponent(token)}`;

  const hdrs = await headers();
  const ua = hdrs.get('user-agent') ?? '';
  const host = hdrs.get('host') ?? '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  const appStoreUrl =
    process.env.NEXT_PUBLIC_APP_STORE_URL ?? 'https://apps.apple.com/us/app/mealo/id123456789';
  const playStoreUrl =
    process.env.NEXT_PUBLIC_PLAY_STORE_URL ??
    'https://play.google.com/store/apps/details?id=com.mealo.app';
  const explicitExpoProjectUrl = process.env.NEXT_PUBLIC_EXPO_PROJECT_URL;
  const guessedExpoProjectUrl =
    process.env.NODE_ENV === 'development' && !explicitExpoProjectUrl && host
      ? `exp://${host.split(':')[0]}:8081`
      : null;
  const expoProjectUrl = explicitExpoProjectUrl ?? guessedExpoProjectUrl;
  const expoGoLink =
    process.env.NODE_ENV === 'development' && expoProjectUrl
      ? `${expoProjectUrl.replace(/\/$/, '')}/--/invite?token=${encodeURIComponent(token)}`
      : null;

  const primaryDownloadUrl = isAndroid ? playStoreUrl : appStoreUrl;

  let householdName: string | null = null;
  let inviterName: string | null = null;
  let expiresAt: Date | null = null;
  let isExpired = false;
  let isInvalid = false;

  if (db) {
    const invite = await db
      .select({
        householdName: households.name,
        inviterName: users.name,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .innerJoin(households, eq(invites.householdId, households.id))
      .innerJoin(users, eq(invites.createdBy, users.id))
      .where(eq(invites.token, token))
      .limit(1);

    if (!invite.length) {
      isInvalid = true;
    } else {
      householdName = invite[0].householdName;
      inviterName = invite[0].inviterName;
      expiresAt = invite[0].expiresAt;
      isExpired = new Date() > invite[0].expiresAt;
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-background to-muted/20 p-4 text-center">
      <div className="w-full max-w-md space-y-8 rounded-3xl bg-card p-8 shadow-2xl border border-border/50">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">
            {isInvalid ? 'Invite link not found' : "You're invited!"}
          </h1>
          {isInvalid ? (
            <p className="text-muted-foreground">
              This invite link looks invalid. Ask the group owner to generate a fresh invite link.
            </p>
          ) : householdName && inviterName ? (
            <p className="text-muted-foreground">
              <span className="font-semibold text-foreground">{inviterName}</span> invited you to join{' '}
              <span className="font-semibold text-foreground">{householdName}</span> on Mealo.
            </p>
          ) : (
            <p className="text-muted-foreground">
              Open Mealo to accept this invite and join the meal group.
            </p>
          )}
        </div>

        {isExpired ? (
          <div className="rounded-xl bg-destructive/10 p-4 text-destructive">
            This invite link has expired. Please ask for a new one.
          </div>
        ) : (
          <div className="space-y-4">
            <Button size="lg" className="w-full gap-2 text-lg h-14" asChild>
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
                Invite details are hidden because <span className="font-mono">DATABASE_URL</span> is not set for
                this web app. The token will still be redeemable inside the Mealo app.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
