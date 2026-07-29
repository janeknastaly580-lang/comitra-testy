import twilio from 'twilio';
import { twilioConfig } from './config.js';

/**
 * `X-Twilio-Signature` verification for every webhook this server exposes.
 *
 * Twilio signs the full request URL plus the sorted POST parameters with
 * HMAC-SHA1, keyed by the account's **Auth Token** (not the API Key secret —
 * this is the one place the Auth Token is used). Without this check, the status
 * callback is an unauthenticated public endpoint that anyone can post to.
 *
 * The comparison itself is delegated to the official SDK's `validateRequest`,
 * which does the canonicalisation and a timing-safe compare.
 */

/**
 * Rebuild the URL Twilio signed.
 *
 * Behind a proxy (Render, Fly, nginx, ngrok) `req.host`/`req.protocol` describe
 * the internal hop, not the public URL Twilio actually called, so several
 * candidates are tried. The configured `TWILIO_STATUS_CALLBACK_URL` is first:
 * it is by definition the exact string Twilio was given.
 */
export function candidateUrls(req) {
  const urls = [];
  const search = req.originalUrl?.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';

  if (twilioConfig.statusCallbackUrl) {
    urls.push(`${twilioConfig.statusCallbackUrl}${search}`);
  }

  const host = req.get?.('x-forwarded-host') || req.get?.('host');
  if (host) {
    const forwardedProto = (req.get?.('x-forwarded-proto') || '').split(',')[0].trim();
    const proto = forwardedProto || req.protocol || 'https';
    const path = req.originalUrl || req.url || '';
    urls.push(`${proto}://${host}${path}`);
    // Public traffic is https even when the app itself was reached over http.
    if (proto !== 'https') urls.push(`https://${host}${path}`);
  }

  return [...new Set(urls)];
}

/**
 * Whether this request really came from Twilio.
 *
 * @param {import('express').Request} req  with a form-parsed `req.body`
 * @returns {boolean}
 */
export function hasValidTwilioSignature(req) {
  // No Auth Token means nothing can be verified, so nothing is trusted.
  if (!twilioConfig.configured || !twilioConfig.authToken) return false;

  const signature = req.get?.('X-Twilio-Signature');
  if (!signature) return false;

  const params = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};

  return candidateUrls(req).some((url) => {
    try {
      return twilio.validateRequest(twilioConfig.authToken, signature, url, params);
    } catch {
      return false;
    }
  });
}

/**
 * Express middleware form. Rejects with 403 and no detail — an attacker probing
 * the endpoint learns nothing about why their forgery failed.
 */
export function requireTwilioSignature(req, res, next) {
  if (hasValidTwilioSignature(req)) return next();
  res.status(403).json({ error: 'Invalid signature.' });
}
