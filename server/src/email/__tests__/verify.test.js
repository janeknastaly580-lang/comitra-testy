// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setSesClientForTests } from '../client.js';
import { resetThrottleForTests } from '../throttle.js';
import {
  checkEmailVerification,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  resetEmailVerificationsForTests,
  startEmailVerification,
} from '../verify.js';
import { parseEmailEnv } from '../config.js';
import {
  clearTestEmailConfig,
  createFakeSesClient,
  FakeSesException,
  TEST_FROM,
  useTestEmailConfig,
} from './fakeSes.js';

const EMAIL = 'person@example.com';

/** The digits a fake client was asked to email, pulled back out of the body. */
function codeFrom(fake, index = 0) {
  return /\b(\d{6})\b/.exec(fake.calls.emails[index].Content.Simple.Body.Text.Data)[1];
}

beforeEach(() => {
  useTestEmailConfig();
  resetThrottleForTests();
  resetEmailVerificationsForTests();
});

afterEach(() => {
  setSesClientForTests(null);
  clearTestEmailConfig();
  vi.useRealTimers();
});

describe('sending a code', () => {
  it('emails a 6-digit code from the configured identity, to one address only', async () => {
    const fake = createFakeSesClient();
    setSesClientForTests(fake);

    const result = await startEmailVerification({ email: 'Person@Example.com ' });

    expect(fake.calls.emails).toHaveLength(1);
    const [mail] = fake.calls.emails;
    expect(mail.Destination.ToAddresses).toEqual([EMAIL]);
    expect(mail.FromEmailAddress).toBe(`Pactista <${TEST_FROM}>`);
    expect(mail.Content.Simple.Subject.Data).toMatch(/\b\d{6}\b/);
    expect(mail.Content.Simple.Body.Text.Data).toMatch(/\b\d{6}\b/);
    // The result carries the destination and a status, and no field that could
    // hold the digits the person was sent.
    expect(result.status).toBe('pending');
    expect(Object.keys(result).sort()).toEqual(['masked', 'status', 'to']);
  });

  it('returns a masked address, so a caller cannot log the real one', async () => {
    setSesClientForTests(createFakeSesClient());
    const { masked } = await startEmailVerification({ email: EMAIL });
    expect(masked).not.toBe(EMAIL);
    expect(masked).toContain('•');
    expect(masked).toContain('@example.com');
  });

  it('issues a different code each time', async () => {
    const fake = createFakeSesClient();
    setSesClientForTests(fake);

    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      // A different address each time, to sidestep the per-address cooldown.
      await startEmailVerification({ email: `person${i}@example.com` });
      seen.add(codeFrom(fake, i));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('rejects an unusable address before spending an SES call', async () => {
    const fake = createFakeSesClient();
    setSesClientForTests(fake);

    await expect(startEmailVerification({ email: 'not-an-address' })).rejects.toMatchObject({
      code: 'bad-email',
      httpStatus: 400,
    });
    expect(fake.calls.emails).toHaveLength(0);
  });

  it('enforces a resend cooldown on the same address', async () => {
    const fake = createFakeSesClient();
    setSesClientForTests(fake);

    await startEmailVerification({ email: EMAIL });
    await expect(startEmailVerification({ email: EMAIL })).rejects.toMatchObject({ code: 'rate-limited' });
    // The second attempt never reached SES.
    expect(fake.calls.emails).toHaveLength(1);
  });

  it('leaves no live code behind when SES refuses the send', async () => {
    const fake = createFakeSesClient({
      onSend: () => {
        throw new FakeSesException('MessageRejected', 400);
      },
    });
    setSesClientForTests(fake);

    await expect(startEmailVerification({ email: EMAIL })).rejects.toMatchObject({ code: 'setup' });
    // Nothing pending: any code would check as "no code was requested".
    await expect(checkEmailVerification({ email: EMAIL, code: '000000' })).rejects.toMatchObject({
      code: 'invalid-code',
    });
  });
});

describe('sending through a SES-hosted template', () => {
  const TEMPLATE = 'comitra-verification-template';

  it('renders the template with the code as its only variable', async () => {
    useTestEmailConfig({ templateName: TEMPLATE, templateVar: 'code' });
    const fake = createFakeSesClient();
    setSesClientForTests(fake);

    await startEmailVerification({ email: EMAIL });

    const [mail] = fake.calls.emails;
    // The subject and both bodies come from AWS now, so nothing inline is sent.
    expect(mail.Content.Simple).toBeUndefined();
    expect(mail.Content.Template.TemplateName).toBe(TEMPLATE);

    // TemplateData must be a JSON *string*; an object renders as an empty box.
    expect(typeof mail.Content.Template.TemplateData).toBe('string');
    const data = JSON.parse(mail.Content.Template.TemplateData);
    expect(Object.keys(data)).toEqual(['code']);
    expect(data.code).toMatch(/^\d{6}$/);

    // Still exactly one recipient, still our own From identity.
    expect(mail.Destination.ToAddresses).toEqual([EMAIL]);
    expect(mail.FromEmailAddress).toBe(`Pactista <${TEST_FROM}>`);
  });

  it('uses the placeholder name the template actually declares', async () => {
    useTestEmailConfig({ templateName: TEMPLATE, templateVar: 'verification_code' });
    const fake = createFakeSesClient();
    setSesClientForTests(fake);

    await startEmailVerification({ email: EMAIL });

    const data = JSON.parse(fake.calls.emails[0].Content.Template.TemplateData);
    expect(Object.keys(data)).toEqual(['verification_code']);
  });

  it('checks a code that was sent through the template', async () => {
    useTestEmailConfig({ templateName: TEMPLATE, templateVar: 'code' });
    const fake = createFakeSesClient();
    setSesClientForTests(fake);

    await startEmailVerification({ email: EMAIL });
    const { code } = JSON.parse(fake.calls.emails[0].Content.Template.TemplateData);

    await expect(checkEmailVerification({ email: EMAIL, code })).resolves.toEqual({ approved: true });
  });

  it('leaves no live code behind when SES does not have the template', async () => {
    useTestEmailConfig({ templateName: 'does-not-exist', templateVar: 'code' });
    const fake = createFakeSesClient({
      onSend: () => {
        throw new FakeSesException('NotFoundException', 404);
      },
    });
    setSesClientForTests(fake);

    await expect(startEmailVerification({ email: EMAIL })).rejects.toMatchObject({ code: 'setup' });
    await expect(checkEmailVerification({ email: EMAIL, code: '000000' })).rejects.toMatchObject({
      code: 'invalid-code',
    });
  });
});

describe('checking a code', () => {
  it('approves the right code exactly once', async () => {
    const fake = createFakeSesClient();
    setSesClientForTests(fake);
    await startEmailVerification({ email: EMAIL });
    const code = codeFrom(fake);

    await expect(checkEmailVerification({ email: EMAIL, code })).resolves.toEqual({ approved: true });
    // Single use: replaying the same code inside the TTL is refused.
    await expect(checkEmailVerification({ email: EMAIL, code })).rejects.toMatchObject({ code: 'invalid-code' });
  });

  it('accepts the address in any case, as it was normalised on send', async () => {
    const fake = createFakeSesClient();
    setSesClientForTests(fake);
    await startEmailVerification({ email: EMAIL });
    const code = codeFrom(fake);

    await expect(checkEmailVerification({ email: 'PERSON@Example.COM', code })).resolves.toEqual({
      approved: true,
    });
  });

  it('destroys the code after too many wrong guesses', async () => {
    const fake = createFakeSesClient();
    setSesClientForTests(fake);
    await startEmailVerification({ email: EMAIL });
    const code = codeFrom(fake);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await expect(checkEmailVerification({ email: EMAIL, code: wrong })).rejects.toMatchObject({
        code: 'invalid-code',
      });
    }
    await expect(checkEmailVerification({ email: EMAIL, code: wrong })).rejects.toMatchObject({
      code: 'rate-limited',
    });
    // Burnt: even the correct code no longer works.
    await expect(checkEmailVerification({ email: EMAIL, code })).rejects.toMatchObject({ code: 'invalid-code' });
  });

  it('keeps a code alive for 7 minutes from generation, and not a minute longer', async () => {
    vi.useFakeTimers();
    const fake = createFakeSesClient();
    setSesClientForTests(fake);
    await startEmailVerification({ email: EMAIL });
    const code = codeFrom(fake);

    // The stated contract, not just "whatever CODE_TTL_MS happens to be" — the
    // email tells the person seven minutes, so this is what must be true.
    expect(CODE_TTL_MS).toBe(7 * 60_000);
    expect(fake.calls.emails[0].Content.Simple.Body.Text.Data).toContain('7 minutes');

    // A second before the deadline it still works.
    vi.advanceTimersByTime(7 * 60_000 - 1000);
    await expect(checkEmailVerification({ email: EMAIL, code })).resolves.toEqual({ approved: true });
  });

  it('expires a code after its TTL', async () => {
    vi.useFakeTimers();
    const fake = createFakeSesClient();
    setSesClientForTests(fake);
    await startEmailVerification({ email: EMAIL });
    const code = codeFrom(fake);

    vi.advanceTimersByTime(CODE_TTL_MS + 1000);
    await expect(checkEmailVerification({ email: EMAIL, code })).rejects.toMatchObject({ code: 'invalid-code' });
  });

  it('refuses a code that was never requested for that address', async () => {
    await expect(checkEmailVerification({ email: 'stranger@example.com', code: '123456' })).rejects.toMatchObject({
      code: 'invalid-code',
    });
  });
});

describe('configuration', () => {
  it('is off, without complaint, when nothing is filled in', () => {
    const parsed = parseEmailEnv({});
    expect(parsed.configured).toBe(false);
    expect(parsed.problems).toEqual([]);
  });

  it('is on when the region and the From address are both set', () => {
    const parsed = parseEmailEnv({ SES_REGION: 'eu-central-1', SES_FROM_EMAIL: TEST_FROM });
    expect(parsed).toMatchObject({ configured: true, region: 'eu-central-1', fromEmail: TEST_FROM });
    expect(parsed.problems).toEqual([]);
  });

  it('refuses a half-filled block rather than failing at send time', () => {
    const parsed = parseEmailEnv({ SES_REGION: 'eu-central-1' });
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toMatch(/SES_FROM_EMAIL/);
  });

  it('catches a display name pasted into the From address', () => {
    const parsed = parseEmailEnv({ SES_REGION: 'eu-central-1', SES_FROM_EMAIL: `Pactista <${TEST_FROM}>` });
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toMatch(/bare email address/);
  });

  it('catches a region that is not an AWS region id', () => {
    const parsed = parseEmailEnv({ SES_REGION: 'europe', SES_FROM_EMAIL: TEST_FROM });
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toMatch(/SES_REGION/);
  });

  it('refuses half a key pair, which would silently fall back to the default chain', () => {
    const parsed = parseEmailEnv({
      SES_REGION: 'eu-central-1',
      SES_FROM_EMAIL: TEST_FROM,
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    });
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toMatch(/AWS_SECRET_ACCESS_KEY/);
  });

  it('accepts no keys at all, so an IAM role can be used instead', () => {
    const parsed = parseEmailEnv({ SES_REGION: 'eu-central-1', SES_FROM_EMAIL: TEST_FROM });
    expect(parsed.configured).toBe(true);
    expect(parsed.accessKeyId).toBeNull();
  });

  it('defaults the template placeholder to "code" when no template is named', () => {
    const parsed = parseEmailEnv({ SES_REGION: 'eu-central-1', SES_FROM_EMAIL: TEST_FROM });
    expect(parsed.templateName).toBeNull();
    expect(parsed.templateVar).toBe('code');
  });

  it('picks up a SES-hosted template and its placeholder', () => {
    const parsed = parseEmailEnv({
      SES_REGION: 'eu-north-1',
      SES_FROM_EMAIL: TEST_FROM,
      SES_TEMPLATE_NAME: 'comitra-verification-template',
      SES_TEMPLATE_VAR: 'verification_code',
    });
    expect(parsed).toMatchObject({
      configured: true,
      templateName: 'comitra-verification-template',
      templateVar: 'verification_code',
    });
  });

  it('refuses a placeholder name SES could never substitute', () => {
    const parsed = parseEmailEnv({
      SES_REGION: 'eu-central-1',
      SES_FROM_EMAIL: TEST_FROM,
      SES_TEMPLATE_NAME: 'tpl',
      SES_TEMPLATE_VAR: '{{code}}',
    });
    expect(parsed.configured).toBe(false);
    expect(parsed.problems.join(' ')).toMatch(/SES_TEMPLATE_VAR/);
  });

  it('drops a display name that could break out of the From header', () => {
    const parsed = parseEmailEnv({
      SES_REGION: 'eu-central-1',
      SES_FROM_EMAIL: TEST_FROM,
      SES_FROM_NAME: 'Evil" <attacker@elsewhere.test>',
    });
    expect(parsed.fromName).toBe('Pactista');
  });
});
