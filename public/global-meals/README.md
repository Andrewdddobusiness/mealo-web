Place predefined (global) meal images in this folder.

Recommended:
- Format: `.png`, `.jpg` (or `.webp`)
- Size: ~1200×1200 (square) or larger
- No text / no watermark

Setup:
- Add `OPENAI_API_KEY=...` to `mealo-web/mealo-web/.env.local` (required to generate images)
- Ensure `DATABASE_URL=...` is set in `mealo-web/mealo-web/.env.local` (required to seed `global_meals.image`)

Generate images (OpenAI):
- (From `mealo-web/mealo-web`)
- Wizard (recommended): `npm run -s generate:global-meal-images` (choose generate/preview + pick meals)
- List: `npm run -s generate:global-meal-images -- --list`
- Pick a batch: `npm run -s generate:global-meal-images -- --apply --range "1,3-5"`
- Pick one: `npm run -s generate:global-meal-images -- --apply --only "Butter Chicken"`
- Interactive picker: `npm run -s generate:global-meal-images -- --apply --select`

After images are generated:
- They will be written into `mealo-web/mealo-web/public/global-meals/`
- Deploy `mealo-web` so they are available at `https://www.mealo.website/global-meals/<filename>`
- Then backfill the DB with the URLs:
  - `npm run -s seed:global-meal-images -- --apply --force`
