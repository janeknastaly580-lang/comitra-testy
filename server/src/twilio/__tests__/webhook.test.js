// @vitest-environment node
import { createHmac } from 'node:crypto';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTwilioWebhookRouter } from '../../routes/twilioWebhook.js';
import { clearTestTwilioConfig, TEST_AUTH_TOKEN, useTestTwilioConfig } from './fakeTwilio.js';

/**
 * The signature check is the only thing standing between Twilio's status
 * callback and the open internet, so it is tested against a signature computed
 * independently here — Twilio's documented algorithm, not the SDK's own code:
 *
 *   HMAC-SHA1( authToken, fullUrl + concat(sorted(key + value)) ), base64
 */
function twilioSignature(authToken, url, params) {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf-8')).digest('base64');
}

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/twilio', createTwilioWebhookRouter());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  // The URL Twilio was told to call is the one it signs.
  useTestTwilioConfig({ statusCallbackUrl: `${baseUrl}/api/twilio/status-callback` });
});

afterEach(() => clearTestTwilioConfig());

const PARAMS = {
  MessageSid: `SM${'e'.repeat(32)}`,
  MessageStatus: 'delivered',
  To: '+48500100200',
  MessagingServiceSid: `MG${'d'.repeat(32)}`,
};

async function postCallback({ signature, params = PARAMS, path = '/api/twilio/status-callback' }) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (signature !== undefined) headers['X-Twilio-Signature'] = signature;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  });
}

describe('Twilio status callback', () => {
  it('accepts a correctly signed request', async () => {
    const url = `${baseUrl}/api/twilio/status-callback`;
    const res = await postCallback({ signature: twilioSignature(TEST_AUTH_TOKEN, url, PARAMS) });
    expect(res.status).toBe(204);
  });

  it('rejects a request with no signature at all', async () => {
    const res = await postCallback({ signature: undefined });
    expect(res.status).toBe(403);
  });

  it('rejects a forged signature', async () => {
    const res = await postCallback({ signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    expect(res.status).toBe(403);
  });

  it('rejects a signature made with the wrong auth token', async () => {
    const url = `${baseUrl}/api/twilio/status-callback`;
    const res = await postCallback({ signature: twilioSignature('the-wrong-token', url, PARAMS) });
    expect(res.status).toBe(403);
  });

  it('rejects a replay whose parameters were tampered with', async () => {
    const url = `${baseUrl}/api/twilio/status-callback`;
    // Signature captured for a real payload…
    const signature = twilioSignature(TEST_AUTH_TOKEN, url, PARAMS);
    // …then reused with a different status.
    const res = await postCallback({ signature, params: { ...PARAMS, MessageStatus: 'failed' } });
    expect(res.status).toBe(403);
  });

  it('rejects everything when no auth token is configured', async () => {
    const url = `${baseUrl}/api/twilio/status-callback`;
    const signature = twilioSignature(TEST_AUTH_TOKEN, url, PARAMS);
    clearTestTwilioConfig();
    const res = await postCallback({ signature });
    expect(res.status).toBe(403);
  });

  it('says nothing about why a forgery failed', async () => {
    const res = await postCallback({ signature: 'nope' });
    const body = await res.json();
    expect(body.error).toBe('Invalid signature.');
    expect(JSON.stringify(body)).not.toContain('token');
    expect(JSON.stringify(body)).not.toContain('url');
  });
});
