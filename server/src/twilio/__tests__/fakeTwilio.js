/**
 * A stand-in for the Twilio REST client.
 *
 * Test doubles only ever live here: production code always talks to the real
 * `twilio` SDK. This records the arguments the SDK would have been called with,
 * so the tests can assert on what WOULD have been sent without a network call,
 * a credential or a charge.
 */
import { twilioConfig } from '../config.js';

const AC = `AC${'a'.repeat(32)}`;
const SK = `SK${'b'.repeat(32)}`;
const MG = `MG${'d'.repeat(32)}`;

export const TEST_AUTH_TOKEN = '0123456789abcdef0123456789abcdef';
export const TEST_SIDS = { AC, SK, MG };

/**
 * Put the process into "Twilio is configured" state for the duration of a test
 * file, with fake but well-formed credentials.
 */
export function useTestTwilioConfig(overrides = {}) {
  Object.assign(twilioConfig, {
    configured: true,
    problems: [],
    accountSid: AC,
    apiKeySid: SK,
    apiKeySecret: 'test-secret',
    authToken: TEST_AUTH_TOKEN,
    messagingServiceSid: MG,
    statusCallbackUrl: null,
    ...overrides,
  });
  return twilioConfig;
}

/** Reset the config back to "SMS is off". */
export function clearTestTwilioConfig() {
  Object.assign(twilioConfig, {
    configured: false,
    problems: [],
    accountSid: undefined,
    apiKeySid: undefined,
    apiKeySecret: undefined,
    authToken: null,
    messagingServiceSid: undefined,
    statusCallbackUrl: null,
  });
}

/** An error shaped like Twilio's `RestException`. */
export class FakeRestException extends Error {
  constructor(code, status = 400, message = 'twilio error') {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Build a fake client.
 *
 * @param {object} handlers
 * @param {(args: object) => object|Promise<object>} [handlers.onMessageCreate]
 */
export function createFakeTwilioClient(handlers = {}) {
  const calls = { messages: [] };

  return {
    calls,
    messages: {
      create: async (args) => {
        calls.messages.push(args);
        return handlers.onMessageCreate
          ? handlers.onMessageCreate(args)
          : { sid: `SM${'e'.repeat(32)}`, status: 'queued' };
      },
    },
  };
}
