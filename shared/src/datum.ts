/**
 * The Datum is the single most important type in this codebase.
 *
 * Every figure that originates outside our own process — a price, a shipping
 * cost, a tax amount, a delivery window, a review count, a coupon's validity —
 * is wrapped in a Datum. There is deliberately no way to express "the shipping
 * cost is 19.90" without also expressing where that came from and when it was
 * observed. A value we do not have is a first-class state, not `null` and not
 * a zero that renders as "free".
 *
 * Consequences that the rest of the system relies on:
 *   - A renderer that receives `UNKNOWN` cannot accidentally print a number.
 *   - A total built from any non-KNOWN part degrades to ESTIMATED or UNKNOWN;
 *     it can never present itself as exact (see pricing/engine.ts).
 *   - A capability a provider has not licensed to us surfaces as RESTRICTED,
 *     which the UI explains without leaking policy detail at the user.
 */

/** Why a value is absent. Distinguishes "nobody knows" from "we may not say". */
export type UnknownReason =
  /** The source responded but omitted the field entirely. */
  | 'NOT_PROVIDED_BY_SOURCE'
  /** The source has the field but the value was unparseable or out of range. */
  | 'SOURCE_VALUE_INVALID'
  /** The call that would have produced it failed or timed out. */
  | 'SOURCE_UNAVAILABLE'
  /** Depends on a destination/selection the user has not supplied yet. */
  | 'REQUIRES_USER_CONTEXT'
  /** We hold a value but it is older than its allowed freshness window. */
  | 'STALE_BEYOND_TOLERANCE'
  /** The provider integration for this field is built but not yet enabled. */
  | 'INTEGRATION_PENDING'
  /** We cannot determine it and will not guess (e.g. destination duties). */
  | 'NOT_COMPUTABLE';

export type DataOrigin =
  /** First-party provider API response. */
  | 'PROVIDER_API'
  /** Authorized provider bulk feed / data file. */
  | 'PROVIDER_FEED'
  /** Returned by the provider's own affiliate tooling. */
  | 'AFFILIATE_TOOL'
  /** Derived by us from other Datums (always carries its inputs' weakest state). */
  | 'DERIVED'
  /** Supplied by the signed-in user (e.g. their destination country). */
  | 'USER_INPUT'
  /** Operator-entered value in the admin console, with an audit trail. */
  | 'OPERATOR_INPUT'
  /** Clearly-labelled development fixture. Never shown unlabelled. */
  | 'DEMO_FIXTURE';

export interface Provenance {
  readonly origin: DataOrigin;
  /** Provider id this came from, or `null` for DERIVED/USER_INPUT values. */
  readonly providerId: string | null;
  /** ISO-8601 UTC instant the value was observed at the source. */
  readonly observedAt: string;
  /**
   * Opaque reference to the upstream call or record, for admin debugging.
   * Must never contain credentials or full request bodies.
   */
  readonly sourceRef?: string;
  /** Policy clause that licenses displaying this value, when one applies. */
  readonly policyRef?: string;
}

/** Confidence band. Exposed to users as words, never as a bare percentage. */
export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Estimate<T> {
  /** Lower bound of the plausible range, inclusive. */
  readonly low: T;
  /** Upper bound of the plausible range, inclusive. */
  readonly high: T;
  /**
   * Machine-readable reason the figure is a range rather than a point, e.g.
   * 'SHIPPING_VARIES_BY_SELLER'. The UI maps these to translated copy; it
   * never shows the raw token.
   */
  readonly basis: string;
  readonly confidence: ConfidenceBand;
}

export type Datum<T> =
  | {
      readonly state: 'KNOWN';
      readonly value: T;
      readonly provenance: Provenance;
      readonly confidence?: ConfidenceBand;
    }
  | {
      readonly state: 'ESTIMATED';
      readonly estimate: Estimate<T>;
      readonly provenance: Provenance;
    }
  | {
      readonly state: 'UNKNOWN';
      readonly reason: UnknownReason;
      /** Provider we asked, when the absence is attributable to one. */
      readonly providerId?: string | null;
    }
  | {
      readonly state: 'RESTRICTED';
      /** Capability that is not licensed/enabled, e.g. 'reviews'. */
      readonly capability: string;
      readonly providerId: string;
    };

export type DatumState = Datum<unknown>['state'];

// --- Constructors ---------------------------------------------------------

export function known<T>(
  value: T,
  provenance: Provenance,
  confidence?: ConfidenceBand,
): Datum<T> {
  return confidence
    ? { state: 'KNOWN', value, provenance, confidence }
    : { state: 'KNOWN', value, provenance };
}

export function estimated<T>(estimate: Estimate<T>, provenance: Provenance): Datum<T> {
  return { state: 'ESTIMATED', estimate, provenance };
}

export function unknown<T>(reason: UnknownReason, providerId?: string | null): Datum<T> {
  return providerId === undefined
    ? { state: 'UNKNOWN', reason }
    : { state: 'UNKNOWN', reason, providerId };
}

export function restricted<T>(capability: string, providerId: string): Datum<T> {
  return { state: 'RESTRICTED', capability, providerId };
}

// --- Accessors ------------------------------------------------------------

export function isKnown<T>(d: Datum<T>): d is Extract<Datum<T>, { state: 'KNOWN' }> {
  return d.state === 'KNOWN';
}

export function isEstimated<T>(
  d: Datum<T>,
): d is Extract<Datum<T>, { state: 'ESTIMATED' }> {
  return d.state === 'ESTIMATED';
}

/**
 * True when the Datum carries any figure at all (exact or ranged).
 *
 * A type guard, so a caller that has checked can reach `value` or `estimate`
 * without a cast — which is what keeps the "propagate the weakest state" logic
 * in the pricing engine readable.
 */
export function hasValue<T>(
  d: Datum<T>,
): d is Extract<Datum<T>, { state: 'KNOWN' } | { state: 'ESTIMATED' }> {
  return d.state === 'KNOWN' || d.state === 'ESTIMATED';
}

/**
 * The exact value, or `undefined`. Never coerces an estimate to a point.
 *
 * Accepts `undefined` so it composes with optional chaining
 * (`exactValue(offering?.offer.price)`), which is the common shape at call
 * sites that are looking up an offering that may not exist.
 */
export function exactValue<T>(d: Datum<T> | undefined): T | undefined {
  return d !== undefined && d.state === 'KNOWN' ? d.value : undefined;
}

/**
 * The value to use for ordering and filtering. For an estimate this is the
 * midpoint, which is appropriate for ranking but must never be displayed as
 * though it were observed. Returns `undefined` when there is nothing to rank
 * on, so callers must decide explicitly how absent data sorts.
 */
export function comparableValue(d: Datum<number>): number | undefined {
  if (d.state === 'KNOWN') return d.value;
  if (d.state === 'ESTIMATED') return (d.estimate.low + d.estimate.high) / 2;
  return undefined;
}

export function provenanceOf<T>(d: Datum<T>): Provenance | undefined {
  return d.state === 'KNOWN' || d.state === 'ESTIMATED' ? d.provenance : undefined;
}

export function observedAt<T>(d: Datum<T>): string | undefined {
  return provenanceOf(d)?.observedAt;
}

/** True when any input to this Datum was a development fixture. */
export function isDemo<T>(d: Datum<T>): boolean {
  return provenanceOf(d)?.origin === 'DEMO_FIXTURE';
}

// --- Combination ----------------------------------------------------------

const STATE_RANK: Record<DatumState, number> = {
  KNOWN: 0,
  ESTIMATED: 1,
  UNKNOWN: 2,
  RESTRICTED: 3,
};

/**
 * The weakest state among the inputs. A derived figure may never claim a
 * stronger state than the worst thing it was built from — this is what stops
 * an "estimated total" from presenting itself as an observed one.
 */
export function weakestState(inputs: ReadonlyArray<Datum<unknown>>): DatumState {
  let worst: DatumState = 'KNOWN';
  for (const input of inputs) {
    if (STATE_RANK[input.state] > STATE_RANK[worst]) worst = input.state;
  }
  return worst;
}

const BAND_RANK: Record<ConfidenceBand, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function weakestConfidence(
  bands: ReadonlyArray<ConfidenceBand | undefined>,
): ConfidenceBand {
  let worst: ConfidenceBand = 'HIGH';
  for (const band of bands) {
    if (band && BAND_RANK[band] > BAND_RANK[worst]) worst = band;
  }
  return worst;
}

export function confidenceOf<T>(d: Datum<T>): ConfidenceBand | undefined {
  if (d.state === 'KNOWN') return d.confidence ?? 'HIGH';
  if (d.state === 'ESTIMATED') return d.estimate.confidence;
  return undefined;
}

/** Oldest observation among the inputs, used to date a derived figure. */
export function oldestObservation(inputs: ReadonlyArray<Datum<unknown>>): string | undefined {
  let oldest: string | undefined;
  for (const input of inputs) {
    const at = observedAt(input);
    if (at && (oldest === undefined || at < oldest)) oldest = at;
  }
  return oldest;
}

// --- Freshness ------------------------------------------------------------

export interface FreshnessVerdict {
  readonly ageSeconds: number | null;
  readonly stale: boolean;
}

export function freshness(
  d: Datum<unknown>,
  toleranceSeconds: number,
  now: Date = new Date(),
): FreshnessVerdict {
  const at = observedAt(d);
  if (!at) return { ageSeconds: null, stale: false };
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 1000));
  return { ageSeconds, stale: ageSeconds > toleranceSeconds };
}

/**
 * Demotes a Datum whose observation is older than the caller's tolerance.
 * Used at the API boundary so a cached figure can never be presented as
 * current just because it is still in the cache.
 */
export function withFreshnessTolerance<T>(
  d: Datum<T>,
  toleranceSeconds: number,
  now: Date = new Date(),
): Datum<T> {
  const verdict = freshness(d, toleranceSeconds, now);
  if (!verdict.stale) return d;
  const providerId = provenanceOf(d)?.providerId ?? null;
  return unknown<T>('STALE_BEYOND_TOLERANCE', providerId);
}
