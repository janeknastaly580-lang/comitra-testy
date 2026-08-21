/**
 * A stand-in for the Amazon SES client.
 *
 * Test doubles only ever live here: production code always talks to the real
 * `@aws-sdk/client-sesv2`. This records the arguments the SDK would have been
 * called with, so the tests can assert on what WOULD have been sent without a
 * network call, a credential or a charge.
 */
import { emailConfig } from '../config.js';

export const TEST_FROM = 'no-reply@comitra.test';

/**
 * Put the process into "SES is configured" state for the duration of a test
 * file, with fake but well-formed settings.
 */
export function useTestEmailConfig(overrides = {}) {
  Object.assign(emailConfig, {
    configured: true,
    problems: [],
    region: 'eu-central-1',
    fromEmail: TEST_FROM,
    fromName: 'Pactista',
    replyTo: null,
    configurationSet: null,
    accessKeyId: null,
    secretAccessKey: null,
    // No SES-hosted template by default, so tests exercise the inline copy in
    // templates.js. Pass `{ templateName: '…' }` to take the template path.
    templateName: null,
    templateVar: 'code',
    ...overrides,
  });
  return emailConfig;
}

/** Reset the config back to "email is off". */
export function clearTestEmailConfig() {
  Object.assign(emailConfig, {
    configured: false,
    problems: [],
    region: undefined,
    fromEmail: undefined,
    fromName: 'Pactista',
    replyTo: null,
    configurationSet: null,
    accessKeyId: null,
    secretAccessKey: null,
    templateName: null,
    templateVar: 'code',
  });
}

/** An error shaped like an AWS SDK service exception. */
export class FakeSesException extends Error {
  constructor(name, httpStatusCode = 400, message = 'ses error') {
    super(message);
    this.name = name;
    this.$metadata = { httpStatusCode };
  }
}

/**
 * Build a fake `{ client, SendEmailCommand }` pair, the shape `getSesClient()`
 * resolves to.
 *
 * @param {object} handlers
 * @param {(input: object) => object|Promise<object>} [handlers.onSend]
 */
export function createFakeSesClient(handlers = {}) {
  const calls = { emails: [] };

  /** Stands in for the SDK command object: it just carries its input. */
  class SendEmailCommand {
    constructor(input) {
      this.input = input;
    }
  }

  return {
    calls,
    SendEmailCommand,
    client: {
      send: async (command) => {
        calls.emails.push(command.input);
        return handlers.onSend ? handlers.onSend(command.input) : { MessageId: 'test-message-id' };
      },
    },
  };
}
