// @vitest-environment node
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSmsRouter } from '../../routes/sms.js';
import { setTwilioClientForTests } from '../client.js';
import { resetThrottleForTests } from '../throttle.js';
import { resetVerificationsForTests } from '../verify.js';
import { clearTestTwilioConfig, createFakeTwilioClient, useTestTwilioConfig } from './fakeTwilio.js';

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use('/api/sms', createSmsRouter());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  resetThrottleForTests();
  resetVerificationsForTests();
});

afterEach(() => {
  setTwilioClientForTests(null);
  clearTestTwilioConfig();
});

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/sms/status', () => {
  it('reports off, and leaks no SIDs, when Twilio is not configured', async () => {
    clearTestTwilioConfig();
    const res = await fetch(`${baseUrl}/api/sms/status`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configured).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/AC|SK|VA|MG/);
  });

  it('reports on once credentials are present', async () => {
    useTestTwilioConfig();
    const body = await (await fetch(`${baseUrl}/api/sms/status`)).json();
    expect(body).toEqual({ configured: true });
  });
});

describe('when Twilio is not configured', () => {
  beforeEach(() => clearTestTwilioConfig());

  it('answers 503 with a distinguishable code rather than a generic failure', async () => {
    const res = await post('/api/sms/verify/start', { phone: '+48500100200' });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('sms_not_configured');
  });
});

describe('POST /api/sms/verify/start', () => {
  beforeEach(() => {
    useTestTwilioConfig();
    setTwilioClientForTests(createFakeTwilioClient());
  });

  it('never returns the code, and only a masked number', async () => {
    const res = await post('/api/sms/verify/start', { phone: '+48500100200' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'pending', to: expect.stringContaining('•') });
    expect(body.to).not.toBe('+48500100200');
  });

  it('rejects a missing or malformed phone without naming the value back', async () => {
    const res = await post('/api/sms/verify/start', {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('bad-request');
    expect(body.fields).toEqual(['phone']);
  });

  it('rejects a bare national number', async () => {
    const res = await post('/api/sms/verify/start', { phone: '500100200' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-phone');
  });
});

describe('POST /api/sms/verify/check', () => {
  beforeEach(() => useTestTwilioConfig());

  it('approves the code that was texted', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);
    await post('/api/sms/verify/start', { phone: '+48500100200' });
    const code = /\b(\d{6})\b/.exec(fake.calls.messages[0].body)[1];

    const res = await post('/api/sms/verify/check', { phone: '+48500100200', code });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: true });
  });

  it('rejects a wrong code with a message that does not echo it', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);
    await post('/api/sms/verify/start', { phone: '+48500100200' });
    // Derived from the real one so this can never accidentally be right.
    const issued = /\b(\d{6})\b/.exec(fake.calls.messages[0].body)[1];
    const wrong = String((Number(issued) + 1) % 1_000_000).padStart(6, '0');

    const res = await post('/api/sms/verify/check', { phone: '+48500100200', code: wrong });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid-code');
    expect(JSON.stringify(body)).not.toContain(wrong);
    expect(JSON.stringify(body)).not.toContain(issued);
  });
});

describe('POST /api/sms/send', () => {
  beforeEach(() => useTestTwilioConfig());

  it('sends a templated message and reports only the outcome', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    const res = await post('/api/sms/send', {
      to: '+48500100200',
      template: 'goal_not_completed',
      params: { ownerName: 'Ala', goalNumber: 2 },
      idempotencyKey: 'out_11112222',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'queued', duplicate: false });
    expect(fake.calls.messages[0].body).toContain('goal #2');
  });

  it('will not send a body the caller wrote', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);

    // No `template`, just text: rejected outright, so the endpoint can't be
    // used as an open SMS relay.
    const res = await post('/api/sms/send', {
      to: '+48500100200',
      body: 'Your bank account is locked, call +48000000000',
      idempotencyKey: 'out_33334444',
    });

    expect(res.status).toBe(400);
    expect(fake.calls.messages).toHaveLength(0);
  });

  it('is a no-op the second time the same idempotency key arrives', async () => {
    const fake = createFakeTwilioClient();
    setTwilioClientForTests(fake);
    const payload = {
      to: '+48500100200',
      template: 'goal_not_completed',
      params: { ownerName: 'Ala', goalNumber: 2 },
      idempotencyKey: 'out_55556666',
    };

    await post('/api/sms/send', payload);
    const second = await post('/api/sms/send', payload);

    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);
    expect(fake.calls.messages).toHaveLength(1);
  });
});
