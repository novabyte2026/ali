import {
  type Capability,
  type ConfidenceBand,
  type DataOrigin,
  type Datum,
  type Money,
  type Provenance,
  known,
  moneyFromDecimal,
  restricted,
  unknown,
} from '@shelf/shared';
import type { AdapterContext, CapabilityGuard } from './adapter.js';

/**
 * Helpers that turn a raw provider field into a Datum.
 *
 * Every adapter maps through these rather than constructing Datums by hand,
 * because the capability check and the provenance stamp have to happen at the
 * same moment as the read. Doing it later means a value can exist in memory
 * without a recorded source, and then somebody renders it.
 */

export interface MappingContext {
  readonly providerId: string;
  readonly guard: CapabilityGuard;
  /** One timestamp for the whole response, so a page of results agrees. */
  readonly observedAt: string;
  readonly origin: DataOrigin;
  readonly sourceRef?: string;
}

export function mappingContextFrom(
  ctx: AdapterContext,
  providerId: string,
  options: { readonly origin?: DataOrigin; readonly sourceRef?: string } = {},
): MappingContext {
  return {
    providerId,
    guard: ctx.guard,
    observedAt: new Date().toISOString(),
    origin: options.origin ?? 'PROVIDER_API',
    ...(options.sourceRef === undefined ? {} : { sourceRef: options.sourceRef }),
  };
}

export function provenanceFor(ctx: MappingContext, capability: Capability): Provenance {
  const base: Provenance = {
    origin: ctx.origin,
    providerId: ctx.providerId,
    observedAt: ctx.observedAt,
    policyRef: `${ctx.guard.policyVersion}#${capability}`,
  };
  return ctx.sourceRef === undefined ? base : { ...base, sourceRef: ctx.sourceRef };
}

/**
 * The core mapping primitive.
 *
 * Three outcomes, in this order of precedence:
 *   1. The capability is not available  -> RESTRICTED. The UI explains that
 *      this source does not provide the field through our integration; it does
 *      not fall back to another source's value or to a blank.
 *   2. The provider sent nothing usable -> UNKNOWN with a reason.
 *   3. Otherwise                        -> KNOWN with provenance.
 *
 * The capability check comes first deliberately: if we are not permitted to
 * display something, whether the provider happened to send it is irrelevant,
 * and reading it into a Datum at all invites a later leak.
 */
export function mapField<TRaw, TValue>(
  ctx: MappingContext,
  capability: Capability,
  raw: TRaw | null | undefined,
  convert: (value: TRaw) => TValue | null,
  options: {
    readonly absentReason?: 'NOT_PROVIDED_BY_SOURCE' | 'REQUIRES_USER_CONTEXT' | 'NOT_COMPUTABLE';
    readonly confidence?: ConfidenceBand;
  } = {},
): Datum<TValue> {
  const verdict = ctx.guard.check(capability);
  if (!verdict.allowed) return restricted<TValue>(capability, ctx.providerId);

  if (raw === null || raw === undefined || raw === '') {
    return unknown<TValue>(options.absentReason ?? 'NOT_PROVIDED_BY_SOURCE', ctx.providerId);
  }

  const converted = convert(raw);
  if (converted === null) {
    // The field was present but unusable. Distinct from absent: it means our
    // mapper or the provider's format changed, which is worth surfacing in
    // the admin debugger rather than silently reading as "not provided".
    return unknown<TValue>('SOURCE_VALUE_INVALID', ctx.providerId);
  }

  return known(converted, provenanceFor(ctx, capability), options.confidence);
}

export function mapMoney(
  ctx: MappingContext,
  capability: Capability,
  amount: string | number | null | undefined,
  currency: string | null | undefined,
  options: { readonly confidence?: ConfidenceBand } = {},
): Datum<Money> {
  return mapField(
    ctx,
    capability,
    amount,
    (value) => moneyFromDecimal(value, currency),
    options,
  );
}

export function mapString(
  ctx: MappingContext,
  capability: Capability,
  raw: string | null | undefined,
  options: { readonly maxLength?: number } = {},
): Datum<string> {
  return mapField(ctx, capability, raw, (value) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return options.maxLength ? trimmed.slice(0, options.maxLength) : trimmed;
  });
}

export function mapNumber(
  ctx: MappingContext,
  capability: Capability,
  raw: string | number | null | undefined,
  options: { readonly min?: number; readonly max?: number } = {},
): Datum<number> {
  return mapField(ctx, capability, raw, (value) => {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (!Number.isFinite(parsed)) return null;
    if (options.min !== undefined && parsed < options.min) return null;
    if (options.max !== undefined && parsed > options.max) return null;
    return parsed;
  });
}

export function mapInteger(
  ctx: MappingContext,
  capability: Capability,
  raw: string | number | null | undefined,
  options: { readonly min?: number; readonly max?: number } = {},
): Datum<number> {
  return mapField(ctx, capability, raw, (value) => {
    const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return null;
    if (options.min !== undefined && parsed < options.min) return null;
    if (options.max !== undefined && parsed > options.max) return null;
    return parsed;
  });
}

/**
 * Booleans need care. A provider omitting `freeShipping` does not mean
 * shipping is not free, and mapping absence to `false` would render as
 * "shipping: paid" — a claim we cannot support. Absence stays UNKNOWN.
 */
export function mapBoolean(
  ctx: MappingContext,
  capability: Capability,
  raw: boolean | string | null | undefined,
): Datum<boolean> {
  return mapField(ctx, capability, raw, (value) => {
    if (typeof value === 'boolean') return value;
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'no') return false;
    return null;
  });
}

/** An ISO date string field, validated rather than passed through. */
export function mapTimestamp(
  ctx: MappingContext,
  capability: Capability,
  raw: string | number | null | undefined,
): Datum<string> {
  return mapField(ctx, capability, raw, (value) => {
    const parsed = typeof value === 'number' ? new Date(value) : new Date(String(value));
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  });
}

/**
 * Filters image URLs down to those we may display, and rejects anything that
 * is not an https URL — a provider field is still untrusted input, and an
 * attacker-controlled `javascript:` or `data:` URL must not reach an <img>.
 */
export function mapImages(
  ctx: MappingContext,
  raws: ReadonlyArray<{ url?: string | null; width?: number | null; height?: number | null }>,
): Array<{ url: string; width: number | null; height: number | null; displayPermitted: true }> {
  if (!ctx.guard.check('productImages').allowed) return [];

  const seen = new Set<string>();
  const out: Array<{
    url: string;
    width: number | null;
    height: number | null;
    displayPermitted: true;
  }> = [];

  for (const raw of raws) {
    const url = normalizeImageUrl(raw.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      width: Number.isFinite(raw.width) ? (raw.width as number) : null,
      height: Number.isFinite(raw.height) ? (raw.height as number) : null,
      displayPermitted: true,
    });
  }
  return out;
}

export function normalizeImageUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

/**
 * Validates a provider-supplied product URL. Must be https and must belong to
 * a host the provider's policy lists, which stops a compromised or
 * mis-mapped response from turning into an open redirect through our UI.
 */
export function validateSourceUrl(
  ctx: MappingContext,
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const allowed = ctx.guard.allowedDestinationHosts();
  if (allowed.length === 0) return parsed.toString();

  const host = parsed.hostname.toLowerCase();
  const permitted = allowed.some(
    (entry) => host === entry.toLowerCase() || host.endsWith(`.${entry.toLowerCase()}`),
  );
  return permitted ? parsed.toString() : null;
}
