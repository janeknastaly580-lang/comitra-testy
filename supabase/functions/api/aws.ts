/**
 * AWS Signature Version 4, in about eighty lines of Web Crypto.
 *
 * WHY NOT THE SDK: `npm:@aws-sdk/client-sesv2` works in Deno, but it is a large
 * module graph to pull into an isolate that may be cold. Cold start is not a
 * cosmetic concern here — src/lib/email.ts gives the status probe six seconds
 * and the send twelve, and a slow first request is indistinguishable from "email
 * is not configured", which now blocks sign-up. One signed POST does not justify
 * the weight.
 *
 * Reference: docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 */

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(message: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(message)));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

/**
 * The date in the two formats SigV4 wants: `20260812T081023Z` for the header
 * and the credential scope's `20260812`. Both must come from the SAME instant,
 * or the signature covers a scope the request does not claim.
 */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Sign a JSON POST for an AWS service.
 *
 * @param service  e.g. `ses`
 * @param region   e.g. `eu-north-1`
 * @param path     e.g. `/v2/email/outbound-emails`
 */
export async function signJsonPost(
  {
    service,
    region,
    host,
    path,
    body,
    accessKeyId,
    secretAccessKey,
  }: {
    service: string;
    region: string;
    host: string;
    path: string;
    body: string;
    accessKeyId: string;
    secretAccessKey: string;
  },
  now = new Date(),
): Promise<SignedRequest> {
  const { amzDate, dateStamp } = stamps(now);
  const contentType = 'application/json';
  const payloadHash = await sha256Hex(body);
  const signedHeaders = 'content-type;host;x-amz-date';

  // The canonical-headers block must itself end in a newline; the join then
  // supplies the blank line SigV4 requires before the signed-header list.
  const canonicalRequest = [
    'POST',
    path,
    '',
    `content-type:${contentType}\nhost:${host}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));

  return {
    url: `https://${host}${path}`,
    headers: {
      'Content-Type': contentType,
      'X-Amz-Date': amzDate,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  };
}
