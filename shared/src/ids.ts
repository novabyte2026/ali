import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** Prefixed, sortable-enough identifiers. Prefix makes logs readable. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Stable group id for a product identity. Derived from the strongest
 * identifier available so the same product gets the same id across requests
 * and processes without a central allocator.
 */
export function productGroupId(parts: {
  readonly gtin?: string;
  readonly mpn?: string;
  readonly brand?: string;
  readonly model?: string;
  readonly providerId?: string;
  readonly providerProductId?: string;
  readonly variantKey?: string;
}): string {
  const basis = parts.gtin
    ? `gtin:${parts.gtin}`
    : parts.mpn
      ? `mpn:${parts.mpn}`
      : parts.brand && parts.model
        ? `bm:${parts.brand}|${parts.model}`
        : `src:${parts.providerId ?? 'unknown'}|${parts.providerProductId ?? 'unknown'}`;
  const withVariant = parts.variantKey ? `${basis}#${parts.variantKey}` : basis;
  return `pg_${createHash('sha256').update(withVariant).digest('hex').slice(0, 24)}`;
}

/**
 * Pseudonymous session identifier for analytics and rate limiting.
 *
 * Salted with a server secret so it cannot be reversed to the raw session
 * token, and truncated because we only need it to group events within a
 * window — not to identify anyone.
 */
export function sessionHash(sessionToken: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${sessionToken}`).digest('hex').slice(0, 32);
}

/**
 * Cache key for a search. Country and currency are part of the key because
 * they change the answer; locale is not, because it only changes rendering.
 */
export function searchCacheKey(parts: {
  readonly query: string;
  readonly providerIds: ReadonlyArray<string>;
  readonly countryCode: string;
  readonly currency: string;
  readonly filtersFingerprint: string;
  readonly sort: string;
  readonly page: number;
}): string {
  const canonical = [
    parts.query.trim().toLowerCase().replace(/\s+/g, ' '),
    [...parts.providerIds].sort().join(','),
    parts.countryCode.toUpperCase(),
    parts.currency.toUpperCase(),
    parts.filtersFingerprint,
    parts.sort,
    String(parts.page),
  ].join('|');
  return `search:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

/** Stable fingerprint for an arbitrary filter object. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 20);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Constant-time comparison for tokens and OAuth state values. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hashToken(token: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${token}`).digest('hex');
}
