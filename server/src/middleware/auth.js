import { config } from '../config.js';

/**
 * Authentication gate.
 *
 * This is a PLUGGABLE STUB. Replace its body with your real auth (the JWT/session
 * your FineLine app already issues at login). The contract the payment routes rely
 * on is simply: set `req.userId` to the authenticated user's id, or reject.
 *
 * The demo implementation reads a signed, httpOnly cookie named "uid". A signed
 * cookie cannot be forged by the client because it is HMAC'd with COOKIE_SECRET.
 */
export function requireAuth(req, res, next) {
  const userId = req.signedCookies?.uid;
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  req.userId = String(userId);
  next();
}

/**
 * DEV ONLY helper to obtain a session cookie while testing in sandbox.
 * Hard-disabled outside sandbox so it can never create sessions in production.
 */
export function devLogin(req, res) {
  if (config.paypal.env !== 'sandbox') {
    return res.status(404).end();
  }
  const userId = String(req.body?.userId || 'demo-user');
  res.cookie('uid', userId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secureCookies,
    signed: true,
    maxAge: 1000 * 60 * 60 * 8,
  });
  res.json({ ok: true, userId });
}
