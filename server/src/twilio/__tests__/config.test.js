// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseTwilioEnv, TWILIO_ENV_KEYS } from '../config.js';

const AC = `AC${'a'.repeat(32)}`;
const SK = `SK${'b'.repeat(32)}`;
const VA = `VA${'c'.repeat(32)}`;
const MG = `MG${'d'.repeat(32)}`;

/** A complete, well-formed Twilio block. */
function fullEnv(overrides = {}) {
  return {
    TWILIO_ACCOUNT_SID: AC,
    TWILIO_API_KEY_SID: SK,
    TWILIO_API_KEY_SECRET: 'a-real-looking-api-key-secret',
    TWILIO_AUTH_TOKEN: '0123456789abcdef0123456789abcdef',
    TWILIO_VERIFY_SERVICE_SID: VA,
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
    expect(parsed.verifyServiceSid).toBe(VA);
    expect(parsed.messagingServiceSid).toBe(MG);
    expect(parsed.statusCallbackUrl).toBeNull();
  });

  it('refuses a half-filled block instead of failing later on a real send', () => {
    const parsed = parseTwilioEnv(fullEnv({ TWILIO_VERIFY_SERVICE_SID: '' }));
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toContain('TWILIO_VERIFY_SERVICE_SID');
  });

  it('catches a value pasted into the wrong line', () => {
    // Messaging Service SID typed into the Verify slot: both are 34 chars, so
    // only the prefix tells them apart.
    const parsed = parseTwilioEnv(fullEnv({ TWILIO_VERIFY_SERVICE_SID: MG }));
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toContain('Verify Service SID (VA…)');
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

  it('requires the auth token, because the webhook cannot be verified without it', () => {
    const parsed = parseTwilioEnv(fullEnv({ TWILIO_AUTH_TOKEN: '' }));
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toContain('TWILIO_AUTH_TOKEN');
  });
});

describe('status callback URL', () => {
  it('is optional', () => {
    expect(parseTwilioEnv(fullEnv({ TWILIO_STATUS_CALLBACK_URL: '' })).configured).toBe(true);
  });

  it('accepts https, and http only on localhost', () => {
    expect(parseTwilioEnv(fullEnv({ TWILIO_STATUS_CALLBACK_URL: 'https://api.example.com/api/twilio/status-callback' })).configured).toBe(true);
    expect(parseTwilioEnv(fullEnv({ TWILIO_STATUS_CALLBACK_URL: 'http://localhost:4000/api/twilio/status-callback' })).configured).toBe(true);
  });

  it('rejects plain http on a public host and anything that is not a URL', () => {
    expect(parseTwilioEnv(fullEnv({ TWILIO_STATUS_CALLBACK_URL: 'http://api.example.com/cb' })).configured).toBe(false);
    expect(parseTwilioEnv(fullEnv({ TWILIO_STATUS_CALLBACK_URL: '/api/twilio/status-callback' })).configured).toBe(false);
  });
});
