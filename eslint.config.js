import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';

/**
 * ESLint (flat config).
 *
 * Three different kinds of code live in this repo and they need different
 * rules, so the config is split rather than averaged:
 *
 *   src/**        browser + React + TypeScript. Type-aware linting, because the
 *                 types exist and the rules that need them (floating promises,
 *                 misused promises) are the ones that catch real bugs here.
 *   server/**     Node, plain ESM JavaScript, no tsconfig. Non-type-aware —
 *                 pretending otherwise would only produce false confidence.
 *   scripts/**    Node one-off tooling.
 *
 * Two deliberate omissions:
 *
 *   • No formatting rules. The codebase has a consistent hand-written style and
 *     no Prettier; adding one would bury every real finding under a whole-repo
 *     reformat. `npm run lint` reports bugs, not whitespace.
 *   • Plugin rules are listed by NAME rather than spread from the plugins'
 *     own `configs` presets. The preset export names have been renamed across
 *     versions (`recommended` → `flat.recommended` → `recommended-latest`), and
 *     picking the wrong one silently loads an eslintrc-shaped object into a flat
 *     config. Rule names have been stable throughout, so they are what we pin.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-ssr/**',
      'coverage/**',
      'node_modules/**',
      'server/node_modules/**',
      'server/data/**',
      // Native Android project: Java/Gradle, nothing for ESLint to read.
      'android/**',
    ],
  },

  /* ─────────────────────────────────────────── src: browser + React + TS ── */
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        // Resolves each file against the nearest tsconfig, so the type-aware
        // rules below actually have types to work with.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* React correctness. `exhaustive-deps` is a warning on purpose: it has
       * real false positives, and a stale-dep bug is worth surfacing even when
       * the fix is "add an eslint-disable with a reason". */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Vite HMR only works when a module's exports are components.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Matches tsconfig's noUnusedLocals/noUnusedParameters, plus this repo's
      // existing `_req` / `_next` convention for intentionally unused params.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      /* The rules that pay for type-aware linting. A dropped promise here means
       * a text that silently never sends, or a screen stuck on "Loading…" with
       * nothing but an unhandled-rejection warning to show why.
       *
       * WARN, not error, and deliberately so: the app has ~38 inherited
       * instances of one idiom — `useEffect(() => { (async () => {…})(); }, [])`
       * across 22 views. Prefixing each with `void` would silence this rule
       * without handling a single rejection, so the honest state is a visible
       * backlog rather than a green tick. The real fix is one shared
       * `useAsyncEffect` helper in lib/hooks.ts, which is its own change.
       * Intentional fire-and-forget (see lib/api.ts) is marked `void`. */
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': [
        'error',
        // An async function as a JSX onClick is idiomatic React and safe.
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',

      /* Off on purpose. `lib/api.ts` is a mock backend whose whole surface is
       * promise-returning so that swapping it for real network calls needs no
       * change at any call site. Several of those functions genuinely have
       * nothing to await yet; dropping `async` would change their return type
       * and break that contract. */
      '@typescript-eslint/require-await': 'off',

      // `any` erases the strictness the rest of the project relies on, but the
      // existing code has a few pragmatic ones — warn, don't block.
      '@typescript-eslint/no-explicit-any': 'warn',

      /* This is browser code: `process` does not exist here. Vite exposes
       * configuration through import.meta.env, and only VITE_* names — reading
       * process.env is how a server-only secret ends up referenced in a bundle. */
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Browser code: use import.meta.env (VITE_* only), never process.env.' },
      ],

      // console.warn/error/info are used on purpose for diagnostics that must
      // survive in production. A stray console.log is leftover debugging.
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  /* ───────────────────────────────────────── server + scripts: plain Node ── */
  {
    files: ['server/src/**/*.js', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // console IS the logging mechanism on the backend.
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  /* ────────────────────────────────────── build/tooling config at the root ──
   * vite/vitest/tailwind/postcss/capacitor configs. The `.ts` ones need the
   * TypeScript parser, but NOT the type-aware preset: capacitor.config.ts is in
   * no tsconfig, and requiring one just to lint a config file is not worth it.
   */
  {
    files: ['*.config.js', '*.config.ts', '*.config.cjs', '*.config.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: globals.node,
    },
  },

  /* ───────────────────────────────────────────────────────────────── tests ── */
  {
    files: ['**/*.{test,spec}.{js,ts,tsx}', '**/__tests__/**/*.{js,ts,tsx}'],
    plugins: { vitest },
    languageOptions: {
      // vitest.config.ts sets globals: true, so describe/it/expect are ambient.
      globals: { ...globals.node, ...(vitest.environments?.env?.globals ?? {}) },
    },
    rules: {
      // Catches the mistakes that make a test silently always pass.
      'vitest/valid-expect': 'error',
      'vitest/valid-describe-callback': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/expect-expect': 'warn',
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'warn',

      /* Test doubles legitimately poke at internals, reach for `any`, and log.
       * Enforcing the no-unsafe-* family on fixtures buys nothing: a wrongly
       * shaped double makes its own test fail, which is the real check. */
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off',
    },
  },

  /* Ambient type declarations only declare; nothing to lint for unused vars. */
  {
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off', 'no-var': 'off' },
  },
);
