import { createHmac } from 'node:crypto';

/**
 * AliExpress Open Platform request signing.
 *
 * The gateway uses the Taobao/Alibaba TOP signing scheme: all request
 * parameters (system plus business) are sorted by key, concatenated as
 * `key1value1key2value2…`, and signed with the app secret. With
 * `sign_method=sha256` the digest is HMAC-SHA256 over that string, uppercase
 * hex.
 *
 * Two details that cause silent 100%-failure if missed, and are therefore
 * covered by unit tests:
 *   - Sorting is by raw key codepoint, not locale-aware.
 *   - Parameters with an empty or null value are excluded from the signature
 *     *and* from the request. Including an empty one changes the digest.
 */

export interface TopSignInput {
  readonly appSecret: string;
  readonly params: Readonly<Record<string, string | number | boolean | undefined | null>>;
  readonly signMethod?: 'sha256' | 'md5';
}

export function signTopRequest(input: TopSignInput): {
  readonly sign: string;
  readonly params: Record<string, string>;
} {
  const cleaned = cleanParams(input.params);
  const canonical = canonicalString(cleaned);
  const sign = createHmac('sha256', input.appSecret)
    .update(canonical, 'utf8')
    .digest('hex')
    .toUpperCase();
  return { sign, params: cleaned };
}

/** Drops empty values, which must not take part in the signature. */
export function cleanParams(
  params: Readonly<Record<string, string | number | boolean | undefined | null>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text.length === 0) continue;
    out[key] = text;
  }
  return out;
}

export function canonicalString(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join('');
}

/** Gateway timestamp format: 'yyyy-MM-dd HH:mm:ss' in UTC. */
export function topTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

export interface TopRequestEnvelope {
  readonly method: string;
  readonly appKey: string;
  readonly appSecret: string;
  readonly businessParams: Readonly<Record<string, string | number | boolean | undefined | null>>;
  readonly now: Date;
}

/** Builds the fully signed form body for one gateway call. */
export function buildTopRequestBody(envelope: TopRequestEnvelope): string {
  const params = {
    method: envelope.method,
    app_key: envelope.appKey,
    timestamp: topTimestamp(envelope.now),
    format: 'json',
    v: '2.0',
    sign_method: 'sha256',
    simplify: 'true',
    ...envelope.businessParams,
  };

  const { sign, params: cleaned } = signTopRequest({
    appSecret: envelope.appSecret,
    params,
  });

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(cleaned)) body.append(key, value);
  body.append('sign', sign);
  return body.toString();
}
