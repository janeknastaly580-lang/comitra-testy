/**
 * Reports whether Supabase phone (SMS) auth is live for this project, so you can
 * check your Twilio/Supabase setup without opening the app.
 *
 *   npm run sms:status
 *
 * Reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from .env. The anon key is a
 * public key (it is shipped in the browser bundle), and this script only calls
 * the public GoTrue settings endpoint — nothing secret is read or printed.
 */
import { readFileSync } from 'node:fs';

function readEnv() {
  let raw = '';
  try {
    raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = readEnv();
const rawUrl = process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '';

if (!rawUrl || !anonKey) {
  console.error('✖ VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing from .env.');
  process.exit(1);
}

// Same derivation as authBase() in src/lib/supabase.ts.
const origin = rawUrl.replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/auth\/v1$/, '');
const url = `${origin}/auth/v1/settings`;

try {
  const res = await fetch(url, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
  if (!res.ok) {
    console.error(`✖ Could not read auth settings (HTTP ${res.status}). Check the project URL and anon key.`);
    process.exit(1);
  }
  const data = await res.json();
  const phoneOn = data?.external?.phone === true;
  console.log(`Project: ${origin}`);
  console.log('');
  if (phoneOn) {
    console.log('✔ Phone (SMS) auth is ON.');
    console.log('  Judges accepting an invite will be texted a 6-digit code and must enter it.');
    console.log('  If codes still do not arrive, the SMS provider credentials inside Supabase are wrong');
    console.log('  or the Twilio account is out of credit — check Twilio → Monitor → Logs → Messaging.');
  } else {
    console.log('✖ Phone (SMS) auth is OFF — no text messages can be sent yet.');
    console.log('  The app therefore registers judges WITHOUT the code step.');
    console.log('  Follow SMS-SETUP.md: Supabase → Authentication → Sign In / Providers → Phone,');
    console.log('  enable it, paste your Twilio Account SID / Auth Token / Messaging Service SID, save.');
    console.log('  Then run this command again — no redeploy is needed.');
  }
} catch (err) {
  console.error('✖ Could not reach Supabase:', err.message);
  process.exit(1);
}
