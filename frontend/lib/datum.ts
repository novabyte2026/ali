import {
  type ConfidenceBand,
  type Datum,
  type Money,
  type UnknownReason,
  formatMoney,
  formatMoneyRange,
} from '@shelf/shared';
import type { Dictionary } from './i18n/index';
import { localeTag } from './i18n/index';

/**
 * Rendering a Datum.
 *
 * This module is the UI half of the honesty contract. Every component that
 * shows a price, a shipping cost or a delivery estimate goes through
 * `describeMoney` or `describeDatum` and renders the result, which means:
 *
 *   - There is no code path that prints a number without also having its
 *     source and observation time available.
 *   - An UNKNOWN never renders as "0", "—" or an empty cell. It renders as a
 *     sentence in the user's language explaining that it is not known, which is
 *     different from a dash that reads as "free".
 *   - A RESTRICTED renders as "not provided by this source", which is a
 *     different statement from "unknown" and matters to a user deciding
 *     whether the gap is our fault or the store's.
 *   - An ESTIMATED renders as a range, never as its midpoint. The midpoint
 *     exists for sorting and is deliberately not exposed here.
 */

export type DatumTone = 'known' | 'estimated' | 'unknown' | 'restricted';

export interface DatumDescription {
  /** What to show. Always a complete, human phrase. */
  readonly text: string;
  readonly tone: DatumTone;
  /** Secondary line: when it was observed, or why it is a range. */
  readonly note: string | null;
  /** Longer explanation for a tooltip or the trust panel. */
  readonly detail: string | null;
  readonly confidence: ConfidenceBand | null;
  /** True when a figure is present at all, exact or ranged. */
  readonly hasFigure: boolean;
}

export function describeMoney(
  datum: Datum<Money>,
  dict: Dictionary,
  locale: string,
  options: { readonly zeroLabel?: string; readonly now?: Date } = {},
): DatumDescription {
  const tag = localeTag(locale);

  switch (datum.state) {
    case 'KNOWN': {
      // A genuine zero is "free", but only where the caller says a zero is
      // meaningful for this field — a zero price is not "free", it is suspect.
      const isZero = datum.value.minor === 0;
      return {
        text: isZero && options.zeroLabel ? options.zeroLabel : formatMoney(datum.value, tag),
        tone: 'known',
        note: observedNote(datum.provenance.observedAt, dict, options.now),
        detail: conversionNote(datum.provenance.sourceRef, dict),
        confidence: datum.confidence ?? 'HIGH',
        hasFigure: true,
      };
    }

    case 'ESTIMATED': {
      return {
        // A range, never the midpoint. Showing one number for an estimate is
        // how an estimate becomes a quote in the reader's mind.
        text: formatMoneyRange(datum.estimate.low, datum.estimate.high, tag),
        tone: 'estimated',
        note: observedNote(datum.provenance.observedAt, dict, options.now),
        detail: estimateBasisNote(datum.estimate.basis, dict),
        confidence: datum.estimate.confidence,
        hasFigure: true,
      };
    }

    case 'UNKNOWN': {
      return {
        text: unknownLabel(datum.reason, dict),
        tone: 'unknown',
        note: null,
        detail: unknownDetail(datum.reason, dict),
        confidence: null,
        hasFigure: false,
      };
    }

    case 'RESTRICTED': {
      return {
        text: dict.price.restricted,
        tone: 'restricted',
        note: null,
        detail: dict.capability.reasons.NOT_PERMITTED,
        confidence: null,
        hasFigure: false,
      };
    }
  }
}

/** The same treatment for a non-money Datum, with a caller-supplied formatter. */
export function describeDatum<T>(
  datum: Datum<T>,
  dict: Dictionary,
  format: (value: T) => string,
  options: {
    readonly formatRange?: (low: T, high: T) => string;
    readonly now?: Date;
  } = {},
): DatumDescription {
  switch (datum.state) {
    case 'KNOWN':
      return {
        text: format(datum.value),
        tone: 'known',
        note: observedNote(datum.provenance.observedAt, dict, options.now),
        detail: null,
        confidence: datum.confidence ?? 'HIGH',
        hasFigure: true,
      };

    case 'ESTIMATED':
      return {
        text: options.formatRange
          ? options.formatRange(datum.estimate.low, datum.estimate.high)
          : `${format(datum.estimate.low)}–${format(datum.estimate.high)}`,
        tone: 'estimated',
        note: observedNote(datum.provenance.observedAt, dict, options.now),
        detail: estimateBasisNote(datum.estimate.basis, dict),
        confidence: datum.estimate.confidence,
        hasFigure: true,
      };

    case 'UNKNOWN':
      return {
        text: unknownLabel(datum.reason, dict),
        tone: 'unknown',
        note: null,
        detail: unknownDetail(datum.reason, dict),
        confidence: null,
        hasFigure: false,
      };

    case 'RESTRICTED':
      return {
        text: dict.price.restricted,
        tone: 'restricted',
        note: null,
        detail: dict.capability.reasons.NOT_PERMITTED,
        confidence: null,
        hasFigure: false,
      };
  }
}

/**
 * Shipping gets its own helper because it is the field most likely to be
 * misread. An absent shipping cost must never look like free shipping, so the
 * only thing that renders as "free" is an explicit statement from the store.
 */
export function describeShipping(
  cost: Datum<Money>,
  free: Datum<boolean>,
  dict: Dictionary,
  locale: string,
  now?: Date,
): DatumDescription {
  if (free.state === 'KNOWN' && free.value === true) {
    return {
      text: dict.shipping.free,
      tone: 'known',
      note: observedNote(free.provenance.observedAt, dict, now),
      detail: dict.shipping.freeDeclared,
      confidence: 'HIGH',
      hasFigure: true,
    };
  }

  if (cost.state === 'UNKNOWN' || cost.state === 'RESTRICTED') {
    return {
      ...describeMoney(cost, dict, locale, { now: now ?? new Date() }),
      text: cost.state === 'RESTRICTED' ? dict.price.restricted : dict.shipping.costUnknown,
    };
  }

  return describeMoney(cost, dict, locale, { zeroLabel: dict.shipping.free, now: now ?? new Date() });
}

export function describeDeliveryDays(
  datum: Datum<{ readonly low: number; readonly high: number }>,
  dict: Dictionary,
  now?: Date,
): DatumDescription {
  return describeDatum(
    datum,
    dict,
    (value) => dict.shipping.days(value.low, value.high),
    {
      formatRange: (low, high) => dict.shipping.days(low.low, high.high),
      ...(now ? { now } : {}),
    },
  );
}

/**
 * The total. Carries the list of components that are missing from it, so the
 * UI can state what the figure excludes rather than presenting it as complete.
 */
export interface TotalDescription extends DatumDescription {
  readonly missingLabels: ReadonlyArray<string>;
  readonly isComplete: boolean;
}

export function describeTotal(
  total: Datum<Money>,
  missingComponents: ReadonlyArray<string>,
  dict: Dictionary,
  locale: string,
  now?: Date,
): TotalDescription {
  const base = describeMoney(total, dict, locale, { now: now ?? new Date() });

  const missingLabels = missingComponents
    .map((component) => dict.price.missing[component as keyof Dictionary['price']['missing']])
    .filter((label): label is string => Boolean(label));

  return {
    ...base,
    text: base.hasFigure ? base.text : dict.price.totalUnavailable,
    missingLabels,
    isComplete: total.state === 'KNOWN' && missingComponents.length === 0,
  };
}

// --- Internals ------------------------------------------------------------

function unknownLabel(reason: UnknownReason, dict: Dictionary): string {
  switch (reason) {
    case 'NOT_PROVIDED_BY_SOURCE':
      return dict.price.notAvailable;
    case 'SOURCE_VALUE_INVALID':
      return dict.price.notVerified;
    case 'SOURCE_UNAVAILABLE':
      return dict.price.notAvailable;
    case 'REQUIRES_USER_CONTEXT':
      return dict.price.unknown;
    case 'STALE_BEYOND_TOLERANCE':
      return dict.price.notVerified;
    case 'INTEGRATION_PENDING':
      return dict.price.notAvailable;
    case 'NOT_COMPUTABLE':
      return dict.price.notComputable;
  }
}

function unknownDetail(reason: UnknownReason, dict: Dictionary): string | null {
  switch (reason) {
    case 'STALE_BEYOND_TOLERANCE':
      return dict.trust.stale;
    case 'REQUIRES_USER_CONTEXT':
      return dict.coupon.notCountedInTotal;
    // NOT_COMPUTABLE needs no second line: "cannot be calculated" is already
    // the whole statement, and the range note would describe something this
    // value explicitly is not.
    default:
      return null;
  }
}

/**
 * "Checked 4 minutes ago". The product shows this next to every price, which
 * is both a trust signal and, for one of our programmes, a requirement of
 * displaying the price at all.
 */
function observedNote(
  observedAt: string,
  dict: Dictionary,
  now: Date = new Date(),
): string | null {
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return null;

  const seconds = Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
  if (seconds < 90) return dict.price.checkedAt(dict.common.justNow);

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return dict.price.checkedAt(dict.common.minutesAgo(minutes));

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return dict.price.checkedAt(dict.common.hoursAgo(hours));

  return dict.price.checkedAt(dict.common.daysAgo(Math.floor(hours / 24)));
}

/** Surfaces the FX rate's date when a figure was converted. */
function conversionNote(sourceRef: string | undefined, dict: Dictionary): string | null {
  if (!sourceRef?.startsWith('fx:')) return null;
  const asOf = sourceRef.split('@')[1];
  if (!asOf) return null;
  return dict.price.convertedAt(asOf.slice(0, 10));
}

function estimateBasisNote(basis: string, dict: Dictionary): string | null {
  switch (basis) {
    case 'SHIPPING_NOT_PROVIDED_BY_SOURCE':
      return `${dict.price.missingFromTotal}: ${dict.price.missing.SHIPPING}`;
    case 'TAX_ESTIMATED_FROM_DESTINATION_RATE':
    case 'DESTINATION_VAT_RATE_ESTIMATE':
      return dict.price.taxEstimated;
    case 'BELOW_DESTINATION_IMPORT_THRESHOLD':
      return dict.price.rangeNote;
    case 'CURRENCY_CONVERTED_AT_DATED_RATE':
      return dict.price.rangeNote;
    case 'CART_TOTAL_EXCLUDES_UNKNOWN_COMPONENTS':
      return dict.price.rangeNote;
    default:
      return dict.price.rangeNote;
  }
}

/** Relative time for a bare timestamp, outside a Datum. */
export function relativeTime(
  isoTimestamp: string | null | undefined,
  dict: Dictionary,
  now: Date = new Date(),
): string | null {
  if (!isoTimestamp) return null;
  const parsed = Date.parse(isoTimestamp);
  if (!Number.isFinite(parsed)) return null;

  const seconds = Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
  if (seconds < 90) return dict.common.justNow;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return dict.common.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return dict.common.hoursAgo(hours);
  return dict.common.daysAgo(Math.floor(hours / 24));
}

export function formatDate(isoTimestamp: string | null | undefined, locale: string): string | null {
  if (!isoTimestamp) return null;
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(localeTag(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
}

/** True when any input to this value was a development fixture. */
export function isDemoDatum(datum: Datum<unknown>): boolean {
  return (
    (datum.state === 'KNOWN' || datum.state === 'ESTIMATED') &&
    datum.provenance.origin === 'DEMO_FIXTURE'
  );
}
