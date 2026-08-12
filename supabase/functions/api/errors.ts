/**
 * The error shape the frontend already understands.
 *
 * `src/lib/email.ts` and `src/lib/sms.ts` both switch on `code` to pick their
 * wording, so these strings are an API contract, not an implementation detail —
 * changing one silently degrades the app to its generic "something went wrong".
 *
 * `detail` never leaves the server. AWS and Twilio put the account id, the
 * identity and sometimes the recipient into their messages, so only `message`
 * (written for a person, by us) is ever sent.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 502,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Log a failure with its server-only detail, then shape the client response. */
export function failureBody(err: ApiError, route: string): { error: string; code: string } {
  if (err.detail) console.warn(`[${route}]`, err.code, '-', err.detail);
  return { error: err.message, code: err.code };
}
