import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Reveal } from "@/components/marketing/Reveal";

const storeLinks = {
  ios: "https://apps.apple.com/au/app/mealo-meal-planner/id6756686048",
  android: "https://play.google.com/store/apps/details?id=com.mealo.app",
};

const assets = {
  heroScreen: "/screenshots/IMG_3769.PNG",
  downloadPhone: "/screenshots/IMG_3772.PNG",
} as const;

function AppleMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={props.className} aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.35 12.67c.02 2.24 1.96 2.99 1.98 3-.02.05-.3 1.02-1.01 2.02-.61.86-1.25 1.72-2.25 1.74-.98.02-1.29-.58-2.41-.58-1.12 0-1.46.56-2.38.6-.97.04-1.7-.97-2.31-1.83-1.25-1.77-2.2-5-1.16-7.19.52-1.09 1.46-1.78 2.48-1.8.97-.02 1.89.66 2.41.66.52 0 1.51-.82 2.55-.7.44.02 1.69.18 2.49 1.35-.06.04-1.49.87-1.47 2.6ZM14.68 4.97c.5-.6.84-1.44.75-2.27-.72.03-1.59.48-2.1 1.08-.46.53-.86 1.38-.75 2.19.8.06 1.6-.41 2.1-1Z"
      />
    </svg>
  );
}

function PlayMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={props.className} aria-hidden="true">
      <path fill="currentColor" d="M4.2 3.2A1.3 1.3 0 0 0 3 4.5v15a1.3 1.3 0 0 0 2.03 1.08l12.1-7.5a1.3 1.3 0 0 0 0-2.2L5.03 3.42A1.3 1.3 0 0 0 4.2 3.2Zm1.3 3.1 9.4 5.7-9.4 5.7V6.3Z" />
    </svg>
  );
}

function StoreBadge({
  href,
  kind,
}: {
  href: string;
  kind: "ios" | "android";
}) {
  const isIOS = kind === "ios";
  const Icon = isIOS ? AppleMark : PlayMark;
  const top = isIOS ? "Download on the" : "Get it on";
  const bottom = isIOS ? "App Store" : "Google Play";

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-3 rounded-full bg-secondary px-5 py-3 text-white shadow-[0_8px_0_rgba(45,36,31,0.30)] transition-transform duration-150 active:translate-y-[1px] active:shadow-[0_7px_0_rgba(45,36,31,0.30)]"
      aria-label={bottom}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10">
        <Icon className="h-5 w-5" />
      </span>
      <span className="text-left leading-tight">
        <span className="block text-[11px] text-white/75">{top}</span>
        <span className="block text-sm font-semibold">{bottom}</span>
      </span>
    </a>
  );
}

function PhoneMock({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="relative rounded-[3.25rem] bg-black/5 p-2 shadow-[0_40px_120px_rgba(0,0,0,0.18)]">
        <div className="relative overflow-hidden rounded-[2.75rem] bg-black">
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 h-7 w-40 -translate-x-1/2 rounded-full bg-black/90" />
          <div className="relative aspect-[9/19.5] w-full">
            <Image src={src} alt={alt} fill className="object-cover" sizes="420px" />
          </div>
        </div>
      </div>
    </div>
  );
}

function LandingLines() {
  return (
    <svg
      viewBox="0 0 1000 700"
      className="h-full w-full"
      aria-hidden="true"
      fill="none"
    >
      <path
        d="M70 90 L220 90 L270 140 L270 220"
        stroke="rgba(45,36,31,0.10)"
        strokeWidth="2"
      />
      <path
        d="M930 90 L780 90 L730 140 L730 220"
        stroke="rgba(45,36,31,0.10)"
        strokeWidth="2"
      />
      <path
        d="M70 610 L220 610 L270 560 L270 480"
        stroke="rgba(45,36,31,0.10)"
        strokeWidth="2"
      />
      <path
        d="M930 610 L780 610 L730 560 L730 480"
        stroke="rgba(45,36,31,0.10)"
        strokeWidth="2"
      />
      <circle cx="70" cy="90" r="10" stroke="rgba(45,36,31,0.10)" strokeWidth="2" />
      <circle cx="930" cy="90" r="10" stroke="rgba(45,36,31,0.10)" strokeWidth="2" />
      <circle cx="70" cy="610" r="10" stroke="rgba(45,36,31,0.10)" strokeWidth="2" />
      <circle cx="930" cy="610" r="10" stroke="rgba(45,36,31,0.10)" strokeWidth="2" />
      <path
        d="M150 350 L850 350"
        stroke="rgba(45,36,31,0.06)"
        strokeWidth="2"
        strokeDasharray="8 10"
      />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="relative overflow-hidden marketing-soft">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-10 top-10 h-64 w-64 rounded-full bg-primary/20 blur-pill" />
        <div className="absolute right-0 top-24 h-56 w-56 rounded-full bg-primary/15 blur-pill" />
        <div className="absolute bottom-0 left-1/2 h-52 w-52 -translate-x-1/2 rounded-full bg-primary/12 blur-pill" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-6 pb-16 pt-10 sm:px-10">
        <div className="marketing-frame relative overflow-hidden rounded-[2.75rem] backdrop-blur-md">
          <div className="pointer-events-none absolute inset-12 opacity-30">
            <LandingLines />
          </div>

          <Reveal>
            <header className="relative flex items-center justify-between px-6 py-6 sm:px-10">
              <div className="flex items-center gap-3">
                <Image
                  src="/app-icon.png"
                  alt="Mealo"
                  width={40}
                  height={40}
                  className="rounded-full"
                />
                <div className="leading-tight">
                  <p className="text-sm font-semibold text-foreground">Mealo</p>
                  <p className="text-xs text-muted">Create your cookbook</p>
                </div>
              </div>

              <nav className="hidden items-center gap-7 text-sm font-medium text-muted sm:flex">
                <a href="#home" className="transition-colors hover:text-foreground">
                  Home
                </a>
                <a href="#how" className="transition-colors hover:text-foreground">
                  How it works
                </a>
                <a href="#testimonials" className="transition-colors hover:text-foreground">
                  Testimonials
                </a>
                <a href="#download" className="transition-colors hover:text-foreground">
                  Download
                </a>
              </nav>

              <Button
                size="sm"
                className="bg-secondary text-white hover:opacity-90 [--btn-shadow:rgba(45,36,31,0.35)]"
                asChild
              >
                <a href={storeLinks.ios} target="_blank" rel="noreferrer">
                  Download app
                </a>
              </Button>
            </header>
          </Reveal>

          <main className="relative px-6 pb-16 sm:px-10">
            {/* Hero */}
            <section id="home" className="pt-8">
              <div className="mx-auto max-w-3xl text-center">
                <Reveal delayMs={0}>
                  <Badge variant="accent" className="mx-auto w-fit">
                    Transform meal planning
                  </Badge>
                </Reveal>

                <Reveal delayMs={120}>
                  <h1 className="mt-6 text-balance text-5xl font-bold leading-[1.02] tracking-tight text-foreground sm:text-6xl">
                    Scan recipes.
                    <br />
                    Build your cookbook.
                    <br />
                    Plan your week.
                  </h1>
                </Reveal>

                <Reveal delayMs={220}>
                  <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-muted">
                    Save recipes from photos and cookbooks, generate new meals with AI, and keep your household in sync.
                  </p>
                </Reveal>

                <Reveal delayMs={320}>
                  <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
                    <StoreBadge href={storeLinks.ios} kind="ios" />
                    <StoreBadge href={storeLinks.android} kind="android" />
                  </div>
                </Reveal>
              </div>

              <Reveal delayMs={420}>
                <div className="mt-10 flex justify-center">
                  <div className="float-soft relative w-[360px] max-w-[92%] translate-y-6 sm:w-[420px]">
                    <PhoneMock src={assets.heroScreen} alt="Mealo preview" className="w-full" />
                  </div>
                </div>
              </Reveal>
            </section>

            {/* Steps */}
            <section id="how" className="mt-24">
              <div className="grid gap-8 md:grid-cols-2 md:items-end">
                <Reveal>
                  <h2 className="text-4xl font-bold leading-tight text-foreground">
                    Simple steps to a
                    <br />
                    calmer week.
                  </h2>
                </Reveal>
              </div>

              <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { n: "01", title: "Scan or import", body: "Capture a recipe from a photo, cookbook page, or recipe sheet." },
                  { n: "02", title: "Organize", body: "Save cuisines, categories, and favorites so you can find recipes fast." },
                  { n: "03", title: "Plan the week", body: "Add meals to days and keep your planner up to date." },
                  { n: "04", title: "Share the plan", body: "Invite your household and plan together in a shared group." },
                ].map((step, index) => (
                  <Reveal key={step.n} delayMs={index * 100} className="h-full">
                    <div className="glass-card flex h-full flex-col rounded-[1.75rem] p-5">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-white">
                          {step.n}
                        </span>
                      </div>
                      <h3 className="mt-4 text-base font-bold text-foreground">{step.title}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
                    </div>
                  </Reveal>
                ))}
              </div>
            </section>

            {/* Testimonials */}
            <section id="testimonials" className="mt-24 rounded-[3rem] bg-white/60 p-10 ring-1 ring-border">
              <div className="grid gap-10 md:grid-cols-2 md:items-start">
                <Reveal>
                  <h2 className="text-3xl font-bold leading-tight text-foreground sm:text-4xl">
                    Customer reviews
                    <br />
                    from real users.
                  </h2>
                </Reveal>
                <div className="grid gap-6 sm:grid-cols-2">
                  {[
                    {
                      name: "Robert M.",
                      body: "Planning meals finally feels simple. Scanning recipes and saving them into a library is the feature I use the most.",
                    },
                    {
                      name: "William B.",
                      body: "The shared planner keeps our household organized. We stopped double-buying groceries and it saves us time every week.",
                    },
                  ].map((t, index) => (
                    <Reveal key={t.name} delayMs={index * 120}>
                      <div className="glass-card rounded-[2rem] p-6">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-white">
                            {t.name
                              .split(" ")
                              .map((p) => p[0])
                              .join("")}
                          </div>
                          <p className="text-sm font-semibold text-foreground">{t.name}</p>
                        </div>
                        <p className="mt-4 text-sm leading-relaxed text-muted">{t.body}</p>
                      </div>
                    </Reveal>
                  ))}
                </div>
              </div>
            </section>

            {/* Download */}
            <section
              id="download"
              className="relative mt-24 overflow-hidden rounded-[3rem] bg-secondary px-8 py-12 text-white ring-1 ring-white/10"
            >
              <div className="grid gap-10 lg:grid-cols-[1fr,1fr] lg:items-center">
                <Reveal>
                  <div className="space-y-5">
                    <p className="text-sm font-semibold text-white/70">Download</p>
                    <h2 className="text-4xl font-bold leading-tight">Download the mobile app</h2>
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <StoreBadge href={storeLinks.ios} kind="ios" />
                      <StoreBadge href={storeLinks.android} kind="android" />
                    </div>
                    <p className="max-w-md text-sm leading-relaxed text-white/70">
                      Start building a recipe library you’ll actually use, then plan meals with your household.
                    </p>
                  </div>
                </Reveal>

                <Reveal delayMs={180}>
                  <div className="relative flex min-h-[220px] justify-center lg:justify-end">
                    <div className="float-soft absolute -bottom-[340px] right-0 w-[320px] max-w-[90%] rotate-6 lg:-bottom-[360px] lg:right-6 lg:w-[360px]">
                      <PhoneMock src={assets.downloadPhone} alt="Mealo preview" className="w-full" />
                    </div>
                  </div>
                </Reveal>
              </div>
            </section>

            <footer className="mt-14 border-t border-border/60 pt-10">
              <div className="flex flex-col items-center justify-between gap-6 md:flex-row">
                <div className="flex items-center gap-2">
                  <Image
                    src="/app-icon.png"
                    alt="Mealo"
                    width={32}
                    height={32}
                    className="rounded-full"
                  />
                  <span className="font-semibold text-foreground">Mealo</span>
                </div>
                <div className="flex gap-8 text-sm text-muted">
                  <a href="#how" className="transition-colors hover:text-foreground">
                    How it works
                  </a>
                  <a href="#testimonials" className="transition-colors hover:text-foreground">
                    Testimonials
                  </a>
                  <a href="#download" className="transition-colors hover:text-foreground">
                    Download
                  </a>
                </div>
                <div className="flex gap-8 text-sm text-muted">
                  <Link href="/terms" className="transition-colors hover:text-foreground">
                    Terms
                  </Link>
                  <Link href="/privacy" className="transition-colors hover:text-foreground">
                    Privacy
                  </Link>
                  <Link href="/faq" className="transition-colors hover:text-foreground">
                    FAQ
                  </Link>
                </div>
              </div>
              <p className="mt-8 text-center text-xs text-muted">© {new Date().getFullYear()} Mealo Inc.</p>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}
