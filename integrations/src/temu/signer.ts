import { createHash, createHmac } from 'node:crypto';

/**
 * Temu partner request signing.
 *
 * The signing scheme a given Temu partner account uses is specified in its own
 * programme documentation. Rather than guess one, this implements the scheme
 * family these marketplace partner APIs use in practice — sorted-parameter
 * canonicalization with a keyed digest — behind a `scheme` switch, so moving
 * to the documented variant is a one-line configuration change and not a
 * rewrite.
 *
 * Marked VERIFICATION_REQUIRED in the capability matrix precisely because this
 * detail is unconfirmed. Nothing in the product calls it until an operator
 * records a real contract.
 */

export type TemuSignScheme =
  /** HMAC-SHA256 over `key1value1key2value2…`, uppercase hex. */
  | 'HMAC_SHA256_SORTED'
  /** MD5 over `secret + key1value1… + secret`, uppercase hex. */
  | 'MD5_SECRET_WRAPPED';

export interface TemuSignInput {
  readonly appKey: string;
  readonly appSecret: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly now: Date;
  readonly scheme?: TemuSignScheme;
}

export interface TemuSignedRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Exposed for the signer unit tests. */
  readonly canonical: string;
  readonly signature: string;
}

export function signTemuRequest(input: TemuSignInput): TemuSignedRequest {
  const scheme = input.scheme ?? 'HMAC_SHA256_SORTED';

  const params: Record<string, string> = {
    app_key: input.appKey,
    timestamp: String(Math.floor(input.now.getTime() / 1000)),
    data_type: 'JSON',
    version: '1.0',
  };
  for (const [key, value] of Object.entries(input.params)) {
    const text = String(value);
    if (text.length > 0) params[key] = text;
  }

  const canonical = canonicalize(params);
  const signature =
    scheme === 'HMAC_SHA256_SORTED'
      ? createHmac('sha256', input.appSecret).update(canonical, 'utf8').digest('hex').toUpperCase()
      : createHash('md5')
          .update(`${input.appSecret}${canonical}${input.appSecret}`, 'utf8')
          .digest('hex')
          .toUpperCase();

  const body = new URLSearchParams({ ...params, sign: signature }).toString();

  return {
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      accept: 'application/json',
    },
    body,
    canonical,
    signature,
  };
}

/** Sorted `key1value1key2value2…`, empty values excluded. */
export function canonicalize(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== '')
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
}
