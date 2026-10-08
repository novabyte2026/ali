import type { Datum } from '../datum.js';
import type { Money } from '../money.js';
import type { ProviderId } from './provider.js';
import type { NormalizedCoupon } from './coupon.js';
import type { ProductGroup } from './product.js';

/**
 * What makes something a deal.
 *
 * Each kind names the evidence it rests on. "LOW_RELATIVE_TO_HISTORY" is only
 * available where we are permitted to retain price observations for that
 * provider, so the Deal Hunter genuinely finds fewer deals on some sources —
 * which is the correct outcome, not a gap to paper over.
 */
export const DEAL_KINDS = [
  /** Provider states a discount against its own reference price. */
  'PROVIDER_STATED_DISCOUNT',
  /** Price dropped versus our own retained observations. */
  'PRICE_DROP_OBSERVED',
  /** Price is low against the retained distribution for this product. */
  'LOW_RELATIVE_TO_HISTORY',
  /** A verified coupon materially reduces the cost. */
  'VERIFIED_COUPON_AVAILABLE',
  /** A verified coupon stacks with a stated discount. */
  'COUPON_PLUS_DISCOUNT',
  /** Same identifier-backed product costs materially less on another source. */
  'CROSS_SOURCE_GAP',
  /** Provider states a promotion end time. */
  'TIME_LIMITED_PROMOTION',
] as const;

export type DealKind = (typeof DEAL_KINDS)[number];

export interface DealEvidence {
  readonly kind: DealKind;
  /** Translation key for the one-line reason shown on the card. */
  readonly messageKey: string;
  /** Savings this evidence accounts for, when quantifiable. */
  readonly savings: Datum<Money>;
  /** Comparison basis, e.g. the other provider id or the observation window. */
  readonly basis: string | null;
}

export interface Deal {
  readonly dealId: string;
  readonly providerId: ProviderId;
  readonly productGroupId: string;
  readonly group: ProductGroup | null;
  readonly evidence: ReadonlyArray<DealEvidence>;
  /** Internal 0..1 strength. Rendered as a band, never as "92% hot". */
  readonly strength: number;
  readonly band: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly coupon: NormalizedCoupon | null;
  /** Provider-stated end time only. We never invent a countdown. */
  readonly endsAt: Datum<string>;
  readonly firstSeenAt: string;
  readonly lastConfirmedAt: string;
  readonly containsDemoData: boolean;
}

/**
 * A user's standing instruction to watch for deals. Capability-aware: a radar
 * scoped to a provider that does not permit deal discovery is refused at
 * creation with an explanation, rather than created and silently never firing.
 */
export interface DealRadarSubscription {
  readonly radarId: string;
  readonly userId: string;
  readonly label: string;
  readonly categoryPath: ReadonlyArray<string> | null;
  readonly keywords: string | null;
  readonly providerIds: ReadonlyArray<ProviderId>;
  readonly budgetMax: Money | null;
  readonly minRating: number | null;
  readonly minStrength: number;
  readonly countryCode: string;
  readonly requireVerifiedCoupon: boolean;
  readonly active: boolean;
  readonly createdAt: string;
  readonly lastScannedAt: string | null;
}

export function dealKindKey(kind: DealKind): string {
  return `deal.kind.${kind}`;
}
