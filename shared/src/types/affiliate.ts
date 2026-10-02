import type { ProviderId } from './provider.js';

/**
 * Affiliate links are never assembled by string concatenation in feature code.
 * Each adapter owns link construction because each programme specifies its own
 * permitted format, and some require calling the provider's own link API rather
 * than appending a parameter.
 *
 * Two things we do not do:
 *   - Cloak the destination. The user is told which store they are going to,
 *     and the destination host is shown before they click.
 *   - Interpose a redirect that strips or rewrites the programme's tracking
 *     parameters, which would break attribution and breach most programmes.
 */

export type LinkPlacement =
  | 'SEARCH_RESULT'
  | 'PRODUCT_PAGE_PRIMARY'
  | 'COMPARISON_ROW'
  | 'COUPON_CARD'
  | 'DEAL_CARD'
  | 'CART_LINE'
  | 'ALERT_EMAIL'
  | 'WATCHLIST_ROW';

export type AffiliateLinkStatus =
  | 'OK'
  /** Programme permits links but credentials are missing. */
  | 'NOT_CONFIGURED'
  /** The provider's link API refused or returned an unusable response. */
  | 'PROVIDER_REFUSED'
  /** Our own validation rejected the produced URL. */
  | 'INVALID'
  /** Capability switched off by policy or operator. */
  | 'BLOCKED';

export interface AffiliateLink {
  readonly providerId: ProviderId;
  /** Plain product URL at the store, shown to the user as the destination. */
  readonly destinationUrl: string;
  /**
   * The URL we actually navigate to. Equals `destinationUrl` when the
   * programme is not configured — we would rather send an untracked visit than
   * a broken or non-compliant one.
   */
  readonly affiliateUrl: string;
  readonly trackingId: string | null;
  readonly campaignId: string | null;
  readonly placement: LinkPlacement;
  readonly status: AffiliateLinkStatus;
  /** True when a disclosure must be rendered adjacent to this link. */
  readonly disclosureRequired: boolean;
  /** Translation key for the provider-specific disclosure text. */
  readonly disclosureKey: string | null;
  /** Host of `destinationUrl`, precomputed for the "you are going to" label. */
  readonly destinationHost: string;
  readonly createdAt: string;
}

export interface AffiliateClickRecord {
  readonly clickId: string;
  readonly providerId: ProviderId;
  /** Null for guests; we store a session hash instead of inventing a user. */
  readonly userId: string | null;
  readonly sessionHash: string;
  readonly productGroupId: string | null;
  readonly providerProductId: string | null;
  readonly placement: LinkPlacement;
  readonly countryCode: string | null;
  readonly deviceType: 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN';
  readonly campaignId: string | null;
  readonly createdAt: string;
}

/**
 * Conversions are reported by the programme, often days later and subject to
 * reversal. We keep the programme's own state rather than treating a click as
 * a sale, and the admin UI labels estimated commission as estimated.
 */
export type ConversionState = 'REPORTED' | 'APPROVED' | 'REVERSED' | 'UNKNOWN';

export interface AffiliateConversionRecord {
  readonly conversionId: string;
  readonly providerId: ProviderId;
  readonly providerOrderRef: string | null;
  readonly clickId: string | null;
  readonly state: ConversionState;
  readonly commissionMinor: number | null;
  readonly commissionCurrency: string | null;
  readonly reportedAt: string;
  readonly settledAt: string | null;
}
