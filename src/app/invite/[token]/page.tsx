import { db } from '@/db';
import { invites, households, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Smartphone, Download } from 'lucide-react';

interface Props {
  params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;

  // Fetch invite details
  const invite = await db.select({
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
    return notFound();
  }

  const { householdName, inviterName, expiresAt } = invite[0];
  const isExpired = new Date() > expiresAt;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-background to-muted/20 p-4 text-center">
      <div className="w-full max-w-md space-y-8 rounded-3xl bg-card p-8 shadow-2xl border border-border/50">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">You're invited!</h1>
          <p className="text-muted-foreground">
            <span className="font-semibold text-foreground">{inviterName}</span> invited you to join{' '}
            <span className="font-semibold text-foreground">{householdName}</span> on Mealo.
          </p>
        </div>

        {isExpired ? (
          <div className="rounded-xl bg-destructive/10 p-4 text-destructive">
            This invite link has expired. Please ask for a new one.
          </div>
        ) : (
          <div className="space-y-4">
            <Button size="lg" className="w-full gap-2 text-lg h-14" asChild>
              <a href={`mealo://invite/${token}`}>
                <Smartphone className="h-5 w-5" />
                Open in Mealo App
              </a>
            </Button>
            
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">Don't have the app?</span>
              </div>
            </div>

            <Button variant="outline" size="lg" className="w-full gap-2" asChild>
              <Link href="https://apps.apple.com/us/app/mealo/id123456789">
                <Download className="h-4 w-4" />
                Download on App Store
              </Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
