/* eslint-disable react/no-unescaped-entities */
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const storeLinks = {
  ios: "https://apps.apple.com/au/app/mealo-meal-planner/id6756686048",
  android: "https://play.google.com/store/apps/details?id=com.mealo.app",
};



export default function Home() {
  return (
    <div className="relative overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-10 top-10 h-64 w-64 rounded-full bg-primary/20 blur-pill" />
        <div className="absolute right-0 top-24 h-56 w-56 rounded-full bg-primary/15 blur-pill" />
        <div className="absolute bottom-0 left-1/2 h-52 w-52 -translate-x-1/2 rounded-full bg-primary/12 blur-pill" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-6 pb-20 pt-10 sm:px-10">
        <header className="flex items-center justify-between rounded-full bg-white/70 px-4 py-3 shadow-sm ring-1 ring-border backdrop-blur-md z-50">
          <div className="flex items-center gap-3">
            <Image src="/app-icon.png" alt="Mealo Logo" width={40} height={40} className="rounded-full" />
            <div>
              <p className="text-sm font-semibold text-foreground">Mealo</p>
              <p className="text-xs text-muted">Plan meals together</p>
            </div>
          </div>
          <nav className="hidden items-center gap-6 text-sm text-muted font-medium sm:flex">
          </nav>
          <div className="hidden sm:flex items-center gap-2">
            <Button variant="secondary" size="sm" asChild>
              <a href={storeLinks.ios} target="_blank" rel="noreferrer">
                Get the app
              </a>
            </Button>
          </div>
        </header>

        <main className="mt-16 flex flex-1 flex-col gap-24">
          {/* Hero Section */}
          <section className="grid items-center gap-12 lg:grid-cols-2">
            <div className="space-y-8 fade-up">
              <Badge variant="accent" className="w-fit">
                Stop wasting food.
              </Badge>
              <h1 className="text-balance text-5xl font-bold leading-[1.1] tracking-tight sm:text-6xl text-foreground">
                Plan together. <span className="text-primary font-serif italic">Shop smarter.</span> Waste less.
              </h1>
              <p className="text-lg text-muted max-w-xl leading-relaxed">
                Stop buying ingredients that don't match. Mealo helps your household coordinate meals, maximize every ingredient, and save money on groceries.
              </p>
              <div className="flex flex-wrap gap-4" id="download">
                <Button size="lg" className="shadow-xl shadow-primary/20 h-12 px-8 text-base" asChild>
                  <a href={storeLinks.ios} target="_blank" rel="noreferrer">
                    Download on App Store
                  </a>
                </Button>
              </div>
              <div className="flex items-center gap-4 text-sm font-medium text-muted">
                <div className="flex -space-x-4 rtl:space-x-reverse">
                  {[1, 2, 3, 4].map((i) => (
                    <Image
                      key={i}
                      src={`/avatar-${i}.png`}
                      alt={`User ${i}`}
                      width={48}
                      height={48}
                      className="h-12 w-12 rounded-full border-2 border-background object-cover"
                    />
                  ))}
                </div>
                Trusted by 10,000+ meticulous planners
              </div>
            </div>

            <div className="relative lg:h-[600px] flex items-center justify-center">
              <div className="absolute inset-0 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-3xl opacity-50" />
              <div className="relative z-10 transform transition-transform hover:scale-[1.02] duration-500">
                <Image
                  src="/hero-app-mockup.png"
                  alt="Mealo App Interface"
                  width={350}
                  height={700}
                  className="drop-shadow-2xl rounded-[3rem] border-8 border-white/50"
                  priority
                />
              </div>
              {/* Floating Elements */}
              <div className="absolute top-20 -left-10 glass-card p-4 rounded-2xl animate-float hidden md:block">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 bg-green-100 rounded-full flex items-center justify-center text-xl">🥬</div>
                  <div>
                    <p className="font-bold text-sm">Leftover Spinach</p>
                    <p className="text-xs text-muted">Used in Tuesday's Lunch</p>
                  </div>
                </div>
              </div>
              <div className="absolute bottom-32 -right-4 glass-card p-4 rounded-2xl animate-float-delayed hidden md:block">
                 <div className="flex items-center gap-3">
                  <div className="h-10 w-10 bg-orange-100 rounded-full flex items-center justify-center text-xl">💰</div>
                  <div>
                    <p className="font-bold text-sm">$45 Saved</p>
                    <p className="text-xs text-muted">this week vs. average</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* CTA Section */}
          <section className="rounded-[3rem] bg-secondary px-6 py-20 text-center text-white relative overflow-hidden">
             <div className="absolute inset-0 bg-[url('/noise.png')] opacity-5 mix-blend-overlay"></div>
             <div className="absolute -top-24 -left-24 w-64 h-64 bg-primary/30 rounded-full blur-3xl"></div>
             <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-primary/30 rounded-full blur-3xl"></div>
             
             <div className="relative z-10 max-w-2xl mx-auto space-y-8">
               <h2 className="text-4xl font-bold sm:text-5xl">Ready to get cooking?</h2>
               <p className="text-white/70 text-lg">Join thousands of happy households planning their meals with Mealo today.</p>
               <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
                  <Button size="lg" className="bg-white text-secondary hover:bg-white/90 h-14 px-8 text-lg">
                    <a href={storeLinks.ios} target="_blank" rel="noreferrer">Download for iOS</a>
                  </Button>
               </div>
             </div>
          </section>

        </main>

        <footer className="mt-24 border-t border-border/50 py-12">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-2">
               <Image src="/app-icon.png" alt="Mealo Logo" width={32} height={32} className="rounded-full" />
               <span className="font-semibold text-foreground">Mealo</span>
            </div>
            <div className="flex gap-8 text-sm text-muted">
               <Link href="/terms" className="text-sm text-muted hover:text-foreground transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="text-sm text-muted hover:text-foreground transition-colors">
              Privacy
            </Link>
            <Link href="/faq" className="text-sm text-muted hover:text-foreground transition-colors">
              FAQ
            </Link>
            </div>
            <p className="text-sm text-muted">© {new Date().getFullYear()} Mealo Inc.</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
