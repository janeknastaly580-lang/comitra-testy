// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setTwilioClientForTests, SmsError } from '../client.js';
import { resetThrottleForTests } from '../throttle.js';
import {
  checkVerification,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  resetVerificationsForTests,
  startVerification,
} from '../verify.js';
import {
  clearTestTwilioConfig,
  createFakeTwilioClient,
  FakeRestException,
  TEST_SIDS,
  useTestTwilioConfig,
} from './fakeTwilio.js';

const PHONE = '+48500100200';

/** The digits a fake client was asked to text, pulled back out of the body. */
function codeFrom(fake, index = 0) {
  return /\b(\d{6})\b/.exec(fake.calls.messages[index].body)[1];
}

beforeEach(() => {
  useTestTwilioConfig();
  resetThrottleForTests();
  resetVerificationsForTests();
});

afterEach(() => {
  setTwilioClientForTests(null);
  clearTestTwilioConfig();
  vi.useRealTimers();
});

describe('sending a code', () => {
  it('texts a 6-digit code through the Messaging Service, never a Verify service', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    const result = await startVerification({ phone: '+48 500 100 200' });

    expect(fake.calls.messages).toHaveLength(1);
    const [msg] = fake.calls.messages;
    expect(msg.to).toBe(PHONE);
    expect(msg.messagingServiceSid).toBe(TEST_SIDS.MG);
    expect(msg.body).toMatch(/\b\d{6}\b/);
    // The result carries the destination and a status, and no field that could
    // hold the digits the person was texted.
    expect(result.status).toBe('pending');
    expect(Object.keys(result).sort()).toEqual(['masked', 'status', 'to']);
  });

  it('returns a masked number, so a caller cannot log the real one', async () => {
    setTwilioClientForTests(createFakeTwilioClient());
    const { masked } = await startVerification({ phone: PHONE });
    expect(masked).not.toBe(PHONE);
    expect(masked).toContain('•');
  });

  it('issues a different code each time', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      // A different number each time, to sidestep the per-number cooldown.
      await startVerification({ phone: `+4850010020${i}` });
      seen.add(codeFrom(fake, i));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('rejects a non-E.164 number before spending a Twilio call', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await expect(startVerification({ phone: '500100200' })).rejects.toMatchObject({
      code: 'bad-phone',
      httpStatus: 400,
    });
    expect(fake.calls.messages).toHaveLength(0);
  });

  it('enforces a resend cooldown on the same number', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: PHONE });
    await expect(startVerification({ phone: PHONE })).rejects.toMatchObject({ code: 'rate-limited' });
    // The second attempt never reached Twilio.
    expect(fake.calls.messages).toHaveLength(1);
  });

  it('limits per number, so one person waiting does not block everyone', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: '+48500100201' });
    await startVerification({ phone: '+48500100202' });
    expect(fake.calls.messages).toHaveLength(2);

    // …but the first number is still inside its own cooldown.
    await expect(startVerification({ phone: '+48500100201' })).rejects.toMatchObject({ code: 'rate-limited' });
    expect(fake.calls.messages).toHaveLength(2);
  });

  it('turns a bad credential into a setup problem, not a user problem', async () => {
    setTwilioClientForTests(
      createFakeTwilioClient({
        onMessageCreate: () => {
          throw new FakeRestException(20003, 401, 'Authenticate');
        },
      }),
    );
    await expect(startVerification({ phone: PHONE })).rejects.toMatchObject({ code: 'setup', httpStatus: 503 });
  });

  it('leaves no live code behind when the text could not be sent', async () => {
    setTwilioClientForTests(
      createFakeTwilioClient({
        onMessageCreate: () => {
          throw new FakeRestException(21612, 400, 'unreachable');
        },
      }),
    );

    const err = await startVerification({ phone: PHONE }).catch((e) => e);
    expect(err).toBeInstanceOf(SmsError);

    // Nothing is pending: a code nobody was shown must not stay checkable.
    await expect(checkVerification({ phone: PHONE, code: '000000' })).rejects.toMatchObject({
      code: 'invalid-code',
      detail: 'no pending code for this number',
    });
  });
});

describe('checking a code', () => {
  it('approves the code that was actually texted', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: PHONE });
    await expect(checkVerification({ phone: PHONE, code: codeFrom(fake) })).resolves.toEqual({ approved: true });
  });

  it('rejects a wrong code', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: PHONE });
    const wrong = String((Number(codeFrom(fake)) + 1) % 1_000_000).padStart(6, '0');
    await expect(checkVerification({ phone: PHONE, code: wrong })).rejects.toMatchObject({ code: 'invalid-code' });
  });

  it('accepts a code once and only once', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: PHONE });
    const code = codeFrom(fake);
    await expect(checkVerification({ phone: PHONE, code })).resolves.toEqual({ approved: true });
    // Replaying the same code after it was consumed must not work.
    await expect(checkVerification({ phone: PHONE, code })).rejects.toMatchObject({ code: 'invalid-code' });
  });

  it('refuses a code for a number that never asked for one', async () => {
    setTwilioClientForTests(createFakeTwilioClient());
    await expect(checkVerification({ phone: PHONE, code: '123456' })).rejects.toMatchObject({
      code: 'invalid-code',
      httpStatus: 400,
    });
  });

  it('refuses a malformed code', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);
    await startVerification({ phone: PHONE });

    await expect(checkVerification({ phone: PHONE, code: 'abcdef' })).rejects.toMatchObject({ code: 'invalid-code' });
    await expect(checkVerification({ phone: PHONE, code: '12' })).rejects.toMatchObject({ code: 'invalid-code' });
    // A malformed code is not a guess, so it did not eat an attempt.
    await expect(checkVerification({ phone: PHONE, code: codeFrom(fake) })).resolves.toEqual({ approved: true });
  });

  it(`gives exactly ${MAX_ATTEMPTS} guesses, then destroys the code`, async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);
    await startVerification({ phone: PHONE });
    const code = codeFrom(fake);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');

    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      await expect(checkVerification({ phone: PHONE, code: wrong })).rejects.toMatchObject({ code: 'invalid-code' });
    }
    // The last one reports that the code is gone, not merely wrong.
    await expect(checkVerification({ phone: PHONE, code: wrong })).rejects.toMatchObject({
      code: 'rate-limited',
      httpStatus: 429,
    });
    // …and the right code no longer works either: it has to be re-requested.
    await expect(checkVerification({ phone: PHONE, code })).rejects.toMatchObject({ code: 'invalid-code' });
  });

  it('expires a code after five minutes', async () => {
    vi.useFakeTimers();
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: PHONE });
    const code = codeFrom(fake);

    vi.advanceTimersByTime(CODE_TTL_MS - 1000);
    await expect(checkVerification({ phone: PHONE, code })).resolves.toEqual({ approved: true });

    // A second code, then past the expiry. Whether the entry was found expired
    // or already swept away is a log-detail difference; the answer is the same.
    resetThrottleForTests();
    await startVerification({ phone: PHONE });
    vi.advanceTimersByTime(CODE_TTL_MS + 1000);
    await expect(checkVerification({ phone: PHONE, code: codeFrom(fake, 1) })).rejects.toMatchObject({
      code: 'invalid-code',
      httpStatus: 400,
    });
  });

  it('retires the previous code when a new one is requested', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: PHONE });
    const first = codeFrom(fake);
    resetThrottleForTests(); // skip the resend cooldown
    await startVerification({ phone: PHONE });
    const second = codeFrom(fake, 1);

    // Two live codes would double the guesses on offer, so the old one is gone.
    await expect(checkVerification({ phone: PHONE, code: first })).rejects.toMatchObject({ code: 'invalid-code' });
    await expect(checkVerification({ phone: PHONE, code: second })).resolves.toEqual({ approved: true });
  });

  it('never echoes the code back in an error', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);
    await startVerification({ phone: PHONE });

    const err = await checkVerification({ phone: PHONE, code: '000000' }).catch((e) => e);
    expect(err.message).not.toContain('000000');
    expect(err.message).not.toContain(codeFrom(fake));
  });
});
