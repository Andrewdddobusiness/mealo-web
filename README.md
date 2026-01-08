This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm install
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Environment variables

The web landing page can optionally look up invite metadata (group name, inviter, expiry) from Neon.

Create `mealo-web/mealo-web/.env.local`:

```bash
# Server-only (do NOT prefix with NEXT_PUBLIC)
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB?sslmode=require"

# Optional: customize store links shown on /invite/[token]
NEXT_PUBLIC_APP_STORE_URL="https://apps.apple.com/..."
NEXT_PUBLIC_PLAY_STORE_URL="https://play.google.com/store/apps/details?id=com.mealo.app"

# Optional (dev only): enables "Open in Expo Go" button on invite page
NEXT_PUBLIC_EXPO_PROJECT_URL="exp://192.168.0.35:8081"
```

If `DATABASE_URL` is not set, `/invite/[token]` still renders, but won’t show group details (the Mealo app will validate/redeem the token).

You can start editing the page by modifying `src/app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Ingredient catalogue seeding (autocomplete)

To seed/expand global ingredient suggestions (used by `/api/ingredients/suggest`) from the icon catalogue:

```bash
# Dry-run only (no DB writes)
npm run seed:ingredients:catalog

# Apply changes (writes to public.ingredients)
node scripts/seed-ingredients-catalog.mjs --apply
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
