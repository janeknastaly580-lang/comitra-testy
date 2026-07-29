// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setTwilioClientForTests } from '../client.js';
import { sendTemplatedSms } from '../messaging.js';
import { renderTemplate } from '../templates.js';
import { resetThrottleForTests } from '../throttle.js';
import {
  clearTestTwilioConfig,
  createFakeTwilioClient,
  FakeRestException,
  TEST_SIDS,
  useTestTwilioConfig,
} from './fakeTwilio.js';

const PHONE = '+48500100200';
const base = { to: PHONE, template: 'goal_not_completed', params: { ownerName: 'Ala', goalNumber: 3 } };

beforeEach(() => {
  useTestTwilioConfig();
  resetThrottleForTests();
});

afterEach(() => {
  setTwilioClientForTests(null);
  clearTestTwilioConfig();
});

describe('sending through the Messaging Service', () => {
  it('sends via the Messaging Service SID, never a hardcoded from-number', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await sendTemplatedSms({ ...base, idempotencyKey: 'out_00000001' });

    expect(fake.calls.messages).toHaveLength(1);
    const [msg] = fake.calls.messages;
    expect(msg.messagingServiceSid).toBe(TEST_SIDS.MG);
    expect(msg.from).toBeUndefined();
    expect(msg.to).toBe(PHONE);
  });

  it('attaches the status callback only when one is configured', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);
    await sendTemplatedSms({ ...base, idempotencyKey: 'out_00000002' });
    expect(fake.calls.messages[0].statusCallback).toBeUndefined();

    useTestTwilioConfig({ statusCallbackUrl: 'https://api.example.com/api/twilio/status-callback' });
    await sendTemplatedSms({ ...base, idempotencyKey: 'out_00000003' });
    expect(fake.calls.messages[1].statusCallback).toBe('https://api.example.com/api/twilio/status-callback');
  });

  it('composes the body itself and ignores any body the caller supplies', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await sendTemplatedSms({
      ...base,
      // A tampered client trying to push its own text through our sender.
      body: 'Click http://evil.example/win to claim your prize',
      params: { ownerName: 'Ala', goalNumber: 3 },
      idempotencyKey: 'out_00000004',
    });

    const sent = fake.calls.messages[0].body;
    expect(sent).toContain('Ala');
    expect(sent).toContain('goal #3');
    expect(sent).not.toContain('evil.example');
  });

  it('refuses an unknown template', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await expect(sendTemplatedSms({ to: PHONE, template: 'anything', idempotencyKey: 'out_00000005' }))
      .rejects.toMatchObject({ code: 'bad-request' });
    expect(fake.calls.messages).toHaveLength(0);
  });

  it('rejects a non-E.164 destination before calling Twilio', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    await expect(sendTemplatedSms({ ...base, to: '500100200', idempotencyKey: 'out_00000006' }))
      .rejects.toMatchObject({ code: 'bad-phone' });
    expect(fake.calls.messages).toHaveLength(0);
  });
});

describe('never sending the same message twice', () => {
  it('is a no-op on a repeat of the same idempotency key', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    const first = await sendTemplatedSms({ ...base, idempotencyKey: 'out_deadbeef' });
    const second = await sendTemplatedSms({ ...base, idempotencyKey: 'out_deadbeef' });

    expect(fake.calls.messages).toHaveLength(1);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.sid).toBe(first.sid);
  });

  it('does not send twice when two requests race', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    const results = await Promise.all([
      sendTemplatedSms({ ...base, idempotencyKey: 'out_racing00' }),
      sendTemplatedSms({ ...base, idempotencyKey: 'out_racing00' }),
    ]);

    expect(fake.calls.messages).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
  });

  it('lets a genuinely failed send be retried', async () => {
    let fail = true;
    const fake = createFakeTwilioClient({
      onMessageCreate: () => {
        if (fail) throw new FakeRestException(30001, 500, 'queue overflow');
        return { sid: 'SM2', status: 'queued' };
      },
    });
    setTwilioClientForTests(fake);

    await expect(sendTemplatedSms({ ...base, idempotencyKey: 'out_retry001' })).rejects.toMatchObject({
      code: 'unavailable',
    });

    fail = false;
    const retry = await sendTemplatedSms({ ...base, idempotencyKey: 'out_retry001' });
    expect(retry.duplicate).toBe(false);
    expect(retry.status).toBe('queued');
    expect(fake.calls.messages).toHaveLength(2);
  });

  it('requires an idempotency key at all', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);
    await expect(sendTemplatedSms({ ...base, idempotencyKey: 'short' })).rejects.toMatchObject({ code: 'bad-request' });
    await expect(sendTemplatedSms({ ...base, idempotencyKey: undefined })).rejects.toMatchObject({ code: 'bad-request' });
    expect(fake.calls.messages).toHaveLength(0);
  });
});

describe('message templates', () => {
  it('never reveals what a goal is, only its number', () => {
    const body = renderTemplate('goal_not_completed', { ownerName: 'Ala', goalNumber: 7 });
    expect(body).toContain('goal #7');
    expect(body).toContain('Ala');
    // The template takes no title/description parameter at all, and ignores one.
    const smuggled = renderTemplate('goal_not_completed', {
      ownerName: 'Ala',
      goalNumber: 7,
      title: 'quit smoking',
      description: 'therapy on Tuesdays',
    });
    expect(smuggled).not.toContain('quit smoking');
    expect(smuggled).not.toContain('therapy');
  });

  it('only puts an https link in a text, never arbitrary text', () => {
    expect(renderTemplate('judge_invite', { ownerName: 'Ala', link: 'https://comitra.app/#/invite/abc' }))
      .toContain('https://comitra.app/#/invite/abc');
    // Not a URL, or not https → the invite templates refuse to render at all.
    expect(renderTemplate('judge_invite', { ownerName: 'Ala', link: 'call this number instead' })).toBeNull();
    expect(renderTemplate('judge_invite', { ownerName: 'Ala', link: 'http://evil.example' })).toBeNull();
    expect(renderTemplate('judge_invite', { ownerName: 'Ala' })).toBeNull();
  });

  it('caps a name so a long one cannot pad a text into extra segments', () => {
    const body = renderTemplate('goal_not_completed', { ownerName: 'A'.repeat(500), goalNumber: 1 });
    expect(body.length).toBeLessThan(300);
  });

  it('falls back to neutral wording rather than printing "undefined"', () => {
    const body = renderTemplate('goal_not_completed', {});
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('NaN');
  });
});
