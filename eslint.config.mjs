import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next ships legacy (extends-based) configs. Convert them to the
// ESLint v9 flat config format to keep `npm run lint` working.
const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts'],
  },
  // Pre-launch: keep `any` usage visible but non-blocking in server routes/AI parsing.
  {
    files: ['src/app/api/**/*.ts', 'src/lib/ai/**/*.ts', 'src/lib/ingredients.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
