// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseTwilioEnv, TWILIO_ENV_KEYS } from '../config.js';

const AC = `AC${'a'.repeat(32)}`;
const SK = `SK${'b'.repeat(32)}`;
const VA = `VA${'c'.repeat(32)}`;
const MG = `MG${'d'.repeat(32)}`;
const AUTH_TOKEN = '0123456789abcdef0123456789abcdef';

/** A complete, well-formed Twilio block: exactly the four required names. */
function fullEnv(overrides = {}) {
  return {
    TWILIO_ACCOUNT_SID: AC,
    TWILIO_API_KEY_SID: SK,
    TWILIO_API_KEY_SECRET: 'a-real-looking-api-key-secret',
    TWILIO_MESSAGING_SERVICE_SID: MG,
    ...overrides,
  };
}

describe('environment validation', () => {
  it('treats an entirely empty block as "SMS is off", not an error', () => {
    const parsed = parseTwilioEnv({});
    expect(parsed.configured).toBe(false);
    expect(parsed.problems).toEqual([]);
  });

  it('also treats the shipped placeholders as empty', () => {
    const blank = Object.fromEntries(TWILIO_ENV_KEYS.map((k) => [k, '']));
    expect(parseTwilioEnv(blank).configured).toBe(false);
    expect(parseTwilioEnv({ ...blank, TWILIO_ACCOUNT_SID: 'PASTE_YOUR_SID' }).configured).toBe(false);
  });

  it('accepts a complete block', () => {
    const parsed = parseTwilioEnv(fullEnv());
    expect(parsed.configured).toBe(true);
    expect(parsed.problems).toEqual([]);
    expect(parsed.accountSid).toBe(AC);
    expect(parsed.messagingServiceSid).toBe(MG);
    expect(parsed.statusCallbackUrl).toBeNull();
  });

  it('refuses a half-filled block instead of failing later on a real send', () => {
    const parsed = parseTwilioEnv(fullEnv({ TWILIO_MESSAGING_SERVICE_SID: '' }));
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toContain('TWILIO_MESSAGING_SERVICE_SID');
  });

  it('catches a value pasted into the wrong line', () => {
    // A Verify SID typed into the Messaging slot: both are 34 chars, so only
    // the prefix tells them apart.
    const parsed = parseTwilioEnv(fullEnv({ TWILIO_MESSAGING_SERVICE_SID: VA }));
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toContain('Messaging Service SID (MG…)');
  });

  it('catches a SID pasted in place of the API key secret', () => {
    const parsed = parseTwilioEnv(fullEnv({ TWILIO_API_KEY_SECRET: SK }));
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toContain('TWILIO_API_KEY_SECRET');
  });

  it('never echoes a credential in a problem message', () => {
    const secret = 'super-secret-value-9999';
    const parsed = parseTwilioEnv(fullEnv({ TWILIO_ACCOUNT_SID: secret }));
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).not.toContain(secret);
  });

  it('does not need a Verify Service — the codes are issued by verify.js', () => {
    // The old build refused to boot without a VA… SID. Nothing asks for one now.
    expect(TWILIO_ENV_KEYS).not.toContain('TWILIO_VERIFY_SERVICE_SID');
    expect(parseTwilioEnv(fullEnv()).configured).toBe(true);
  });

  it('does not need an auth token when there are no delivery receipts', () => {
    // The Auth Token only verifies webhook signatures, so an account that does
    // not use the status callback never has to supply it.
    const parsed = parseTwilioEnv(fullEnv());
    expect(parsed.configured).toBe(true);
    expect(parsed.authToken).toBeNull();
  });

  it('keeps the auth token when one is supplied', () => {
    expect(parseTwilioEnv(fullEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN })).authToken).toBe(AUTH_TOKEN);
  });
});

describe('status callback URL', () => {
  const withToken = (over) => fullEnv({ TWILIO_AUTH_TOKEN: AUTH_TOKEN, ...over });

  it('is optional', () => {
    expect(parseTwilioEnv(fullEnv({ TWILIO_STATUS_CALLBACK_URL: '' })).configured).toBe(true);
  });

  it('accepts https, and http only on localhost', () => {
    expect(parseTwilioEnv(withToken({ TWILIO_STATUS_CALLBACK_URL: 'https://api.example.com/api/twilio/status-callback' })).configured).toBe(true);
    expect(parseTwilioEnv(withToken({ TWILIO_STATUS_CALLBACK_URL: 'http://localhost:4000/api/twilio/status-callback' })).configured).toBe(true);
  });

  it('rejects plain http on a public host and anything that is not a URL', () => {
    expect(parseTwilioEnv(withToken({ TWILIO_STATUS_CALLBACK_URL: 'http://api.example.com/cb' })).configured).toBe(false);
    expect(parseTwilioEnv(withToken({ TWILIO_STATUS_CALLBACK_URL: '/api/twilio/status-callback' })).configured).toBe(false);
  });

  it('demands the auth token, since receipts arrive on a public endpoint', () => {
    // Without it every incoming receipt would be answered 403, silently.
    const parsed = parseTwilioEnv(fullEnv({ TWILIO_STATUS_CALLBACK_URL: 'https://api.example.com/api/twilio/status-callback' }));
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toContain('TWILIO_AUTH_TOKEN');
  });
});
