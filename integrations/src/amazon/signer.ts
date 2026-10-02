import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for the Product Advertising API 5.0.
 *
 * PA-API is an AWS-signed service: requests are POSTed as JSON to a
 * marketplace host with an `X-Amz-Target` header naming the operation, and
 * signed with the Associates account's access key over the service name
 * `ProductAdvertisingAPI`.
 *
 * Implemented here rather than pulled in as a dependency because it is ~80
 * lines of well-specified hashing, and an SDK would add a large transitive
 * tree for one signature. Verified against the published SigV4 test vectors in
 * tests/unit/amazon-signer.test.ts.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'ProductAdvertisingAPI';

export interface SigV4Input {
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region: string;
  readonly host: string;
  readonly path: string;
  readonly target: string;
  readonly payload: string;
  /** Injected so signing is deterministic and testable. */
  readonly now: Date;
}

export interface SignedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function signPaapiRequest(input: SigV4Input): SignedRequest {
  const amzDate = toAmzDate(input.now);
  const dateStamp = amzDate.slice(0, 8);

  // Headers that participate in the signature, lowercase and sorted.
  const signedHeaders: Record<string, string> = {
    'content-encoding': 'amz-1.0',
    'content-type': 'application/json; charset=utf-8',
    host: input.host,
    'x-amz-date': amzDate,
    'x-amz-target': input.target,
  };

  const sortedHeaderNames = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${signedHeaders[name]?.trim()}\n`)
    .join('');
  const signedHeaderList = sortedHeaderNames.join(';');

  const payloadHash = sha256Hex(input.payload);

  const canonicalRequest = [
    'POST',
    input.path,
    '', // PA-API uses no query string
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(input.secretKey, dateStamp, input.region);
  const signature = hmac(signingKey, stringToSign).toString('hex');

  const authorization =
    `${ALGORITHM} Credential=${input.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  return {
    url: `https://${input.host}${input.path}`,
    headers: {
      ...signedHeaders,
      Authorization: authorization,
    },
  };
}

/** The four-step HMAC chain that derives a date/region/service scoped key. */
export function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${secretKey}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** YYYYMMDD'T'HHMMSS'Z' */
export function toAmzDate(date: Date): string {
  return `${date.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
}
