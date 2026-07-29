// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setTwilioClientForTests, SmsError } from '../client.js';
import { resetThrottleForTests } from '../throttle.js';
import { checkVerification, startVerification } from '../verify.js';
import {
  clearTestTwilioConfig,
  createFakeTwilioClient,
  FakeRestException,
  TEST_SIDS,
  useTestTwilioConfig,
} from './fakeTwilio.js';

const PHONE = '+48500100200';

beforeEach(() => {
  useTestTwilioConfig();
  resetThrottleForTests();
});

afterEach(() => {
  setTwilioClientForTests(null);
  clearTestTwilioConfig();
});

describe('sending a code', () => {
  it('asks Twilio Verify to text the number, and never sees the code', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    const result = await startVerification({ phone: '+48 500 100 200' });

    expect(fake.calls.services).toEqual([TEST_SIDS.VA]);
    expect(fake.calls.verifications).toEqual([{ to: PHONE, channel: 'sms' }]);
    // Verify keeps the code: our result carries the destination and a status,
    // and no field that could hold the digits the person was texted.
    expect(result.status).toBe('pending');
    expect(Object.keys(result).sort()).toEqual(['masked', 'status', 'to']);
  });

  it('returns a masked number, so a caller cannot log the real one', async () => {
    setTwilioClientForTests(createFakeTwilioClient());
    const { masked } = await startVerification({ phone: PHONE });
    expect(masked).not.toBe(PHONE);
    expect(masked).toContain('•');
  });

  it('rejects a non-E.164 number before spending a Twilio call', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await expect(startVerification({ phone: '500100200' })).rejects.toMatchObject({
      code: 'bad-phone',
      httpStatus: 400,
    });
    expect(fake.calls.verifications).toHaveLength(0);
  });

  it('enforces a resend cooldown on the same number', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: PHONE });
    await expect(startVerification({ phone: PHONE })).rejects.toMatchObject({ code: 'rate-limited' });
    // The second attempt never reached Twilio.
    expect(fake.calls.verifications).toHaveLength(1);
  });

  it('limits per number, so one person waiting does not block everyone', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await startVerification({ phone: '+48500100201' });
    await startVerification({ phone: '+48500100202' });
    expect(fake.calls.verifications).toHaveLength(2);

    // …but the first number is still inside its own cooldown.
    await expect(startVerification({ phone: '+48500100201' })).rejects.toMatchObject({ code: 'rate-limited' });
    expect(fake.calls.verifications).toHaveLength(2);
  });

  it('turns Twilio 60200 into a "check the number" answer', async () => {
    setTwilioClientForTests(
      createFakeTwilioClient({
        onVerificationCreate: () => {
          throw new FakeRestException(60200, 400, 'Invalid parameter `To`: +48500100200');
        },
      }),
    );

    const err = await startVerification({ phone: PHONE }).catch((e) => e);
    expect(err).toBeInstanceOf(SmsError);
    expect(err.code).toBe('bad-phone');
    // Twilio's own text (which contains the number) must not be forwarded.
    expect(err.message).not.toContain('500100200');
    expect(err.message).not.toContain('Invalid parameter');
  });

  it('turns a bad credential into a setup problem, not a user problem', async () => {
    setTwilioClientForTests(
      createFakeTwilioClient({
        onVerificationCreate: () => {
          throw new FakeRestException(20003, 401, 'Authenticate');
        },
      }),
    );
    await expect(startVerification({ phone: PHONE })).rejects.toMatchObject({ code: 'setup', httpStatus: 503 });
  });
});

describe('checking a code', () => {
  it('approves the code Twilio approves', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await expect(checkVerification({ phone: PHONE, code: '123456' })).resolves.toEqual({ approved: true });
    expect(fake.calls.checks).toEqual([{ to: PHONE, code: '123456' }]);
  });

  it('rejects anything Twilio does not return as approved', async () => {
    setTwilioClientForTests(createFakeTwilioClient({ onCheckCreate: () => ({ status: 'pending' }) }));
    await expect(checkVerification({ phone: PHONE, code: '000000' })).rejects.toMatchObject({ code: 'invalid-code' });
  });

  it('treats an expired/consumed verification (404) as a bad code', async () => {
    setTwilioClientForTests(
      createFakeTwilioClient({
        onCheckCreate: () => {
          throw new FakeRestException(20404, 404, 'not found');
        },
      }),
    );
    await expect(checkVerification({ phone: PHONE, code: '123456' })).rejects.toMatchObject({
      code: 'invalid-code',
      httpStatus: 400,
    });
  });

  it('refuses a malformed code without calling Twilio', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await expect(checkVerification({ phone: PHONE, code: 'abcdef' })).rejects.toMatchObject({ code: 'invalid-code' });
    await expect(checkVerification({ phone: PHONE, code: '12' })).rejects.toMatchObject({ code: 'invalid-code' });
    expect(fake.calls.checks).toHaveLength(0);
  });

  it('stops a brute-force after a handful of wrong codes', async () => {
    const fake = createFakeTwilioClient({ onCheckCreate: () => ({ status: 'pending' }) });
    setTwilioClientForTests(fake);

    for (let i = 0; i < 5; i += 1) {
      await expect(checkVerification({ phone: PHONE, code: '000000' })).rejects.toMatchObject({ code: 'invalid-code' });
    }
    // The 6th guess is refused locally and never reaches Twilio.
    await expect(checkVerification({ phone: PHONE, code: '000000' })).rejects.toMatchObject({ code: 'rate-limited' });
    expect(fake.calls.checks).toHaveLength(5);
  });

  it('forgets the failed attempts once the right code arrives', async () => {
    let approve = false;
    setTwilioClientForTests(
      createFakeTwilioClient({ onCheckCreate: () => ({ status: approve ? 'approved' : 'pending' }) }),
    );

    await expect(checkVerification({ phone: PHONE, code: '000000' })).rejects.toMatchObject({ code: 'invalid-code' });
    approve = true;
    await expect(checkVerification({ phone: PHONE, code: '123456' })).resolves.toEqual({ approved: true });

    // A fresh run of wrong guesses gets the full allowance again.
    approve = false;
    for (let i = 0; i < 5; i += 1) {
      await expect(checkVerification({ phone: PHONE, code: '000000' })).rejects.toMatchObject({ code: 'invalid-code' });
    }
  });
});
