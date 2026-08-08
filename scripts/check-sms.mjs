/**
 * Reports whether SMS is live, so you can check your Twilio setup without
 * opening the app.
 *
 *   npm run sms:status
 *
 * Two checks, in order:
 *   1. the local `.env` — are all the TWILIO_* values filled in?
 *   2. the running backend (`VITE_API_BASE` + /api/sms/status) — does the
 *      deployed server agree?
 *
 * Nothing secret is printed: the script reports only whether each name has a
 * value, never the value itself, and the status endpoint returns booleans.
 */
import { readFileSync } from 'node:fs';

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SERVICE_SID',
  'TWILIO_MESSAGING_SERVICE_SID',
];

/** SID shapes Twilio guarantees; catches a value pasted into the wrong line. */
const SHAPES = {
  TWILIO_ACCOUNT_SID: [/^AC[0-9a-fA-F]{32}$/, 'Account SID (AC…)'],
  TWILIO_API_KEY_SID: [/^SK[0-9a-fA-F]{32}$/, 'API Key SID (SK…)'],
  TWILIO_VERIFY_SERVICE_SID: [/^VA[0-9a-fA-F]{32}$/, 'Verify Service SID (VA…)'],
  TWILIO_MESSAGING_SERVICE_SID: [/^MG[0-9a-fA-F]{32}$/, 'Messaging Service SID (MG…)'],
};

function readEnvFile(relative) {
  let raw;
  try {
    raw = readFileSync(new URL(relative, import.meta.url), 'utf8');
  } catch {
    // A missing file is normal: server/.env only exists once someone makes it.
    return {};
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// server/.env wins over the root .env, matching server/src/env.js.
const env = { ...readEnvFile('../.env'), ...readEnvFile('../server/.env') };
const value = (name) => process.env[name] ?? env[name] ?? '';
const filled = (name) => {
  const v = value(name).trim();
  return v !== '' && !v.startsWith('PASTE_') && !v.startsWith('replace_with');
};

console.log('Local .env');
let localOk = true;
for (const name of REQUIRED) {
  if (!filled(name)) {
    console.log(`  ✖ ${name} — empty`);
    localOk = false;
    continue;
  }
  const shape = SHAPES[name];
  if (shape && !shape[0].test(value(name).trim())) {
    console.log(`  ✖ ${name} — set, but does not look like a Twilio ${shape[1]}`);
    localOk = false;
  } else {
    console.log(`  ✔ ${name} — set`);
  }
}
const callback = value('TWILIO_STATUS_CALLBACK_URL').trim();
console.log(
  callback
    ? `  ✔ TWILIO_STATUS_CALLBACK_URL — set`
    : `  · TWILIO_STATUS_CALLBACK_URL — empty (optional: no delivery receipts)`,
);

console.log('');
if (localOk) {
  console.log('✔ All Twilio values are present locally.');
} else {
  console.log('✖ Twilio is not fully configured locally — see TWILIO_SETUP.md.');
  console.log('  Until every value above is set, the app registers judges WITHOUT the code step.');
}

/* ------------------------------------------------- the deployed backend --- */

const apiBase = (process.env.VITE_API_BASE ?? env.VITE_API_BASE ?? '').trim().replace(/\/+$/, '');
console.log('');
if (!apiBase) {
  console.log('· VITE_API_BASE is not set, so the app has no backend to text through.');
  console.log('  Set it to your server URL (e.g. https://api.example.com) in .env.');
  process.exit(localOk ? 0 : 1);
}

try {
  const res = await fetch(`${apiBase}/api/sms/status`);
  if (!res.ok) {
    console.error(`✖ ${apiBase}/api/sms/status answered HTTP ${res.status}.`);
    process.exit(1);
  }
  const data = await res.json();
  console.log(`Backend: ${apiBase}`);
  if (data?.configured) {
    console.log('✔ The backend has working Twilio credentials — codes and texts will be sent.');
  } else {
    console.log('✖ The backend reports SMS is OFF. Its own environment is missing the TWILIO_* values.');
    console.log('  Filling in .env locally is not enough: set them where the server actually runs.');
    process.exit(1);
  }
} catch (err) {
  console.error(`✖ Could not reach ${apiBase}:`, err.message);
  process.exit(1);
}
