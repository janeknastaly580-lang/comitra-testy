/**
 * The one place `.env` files are loaded. Import this (not `dotenv/config`)
 * before reading `process.env`.
 *
 * Two files are read, in precedence order:
 *   1. `server/.env`      — backend-only secrets (PayPal, cookie/CSRF secrets).
 *   2. `.env` (repo root) — the file the project already uses; the Amazon SES
 *      values live there so there is a single file to fill in.
 *
 * Two rules make that predictable:
 *   • a real environment variable (Vercel/Render/systemd) always wins;
 *   • **a blank value counts as "not set"**, so `SES_REGION=` in `server/.env`
 *     does not shadow a filled-in one in the root `.env`. Both files ship with
 *     the names present and empty, which without this rule would silently
 *     swallow the real values.
 *
 * Vite only exposes `VITE_`-prefixed variables to the browser bundle, so the
 * unprefixed AWS secrets in the root `.env` stay server-side.
 */
import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Read one file and copy across only the values that are actually set. */
function apply(path) {
  // `processEnv: {}` parses into a scratch object instead of mutating
  // process.env, so the blank-is-unset rule below is the only thing that writes.
  const parsed = loadEnvFile({ path, processEnv: {}, quiet: true }).parsed ?? {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const current = process.env[key];
    if (typeof current === 'string' && current.trim() !== '') continue;
    process.env[key] = value;
  }
}

apply(resolve(here, '../.env'));
apply(resolve(here, '../../.env'));
