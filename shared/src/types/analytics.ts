import type { ProviderId } from './provider.js';

/**
 * Analytics is deliberately narrow. We record what the product needs in order
 * to work and to be operated — latency, failure rates, which sources answered,
 * whether a comparison was opened — and we do not build a behavioural profile
 * as a side effect.
 *
 * Search terms are recorded against a session hash, not a user id, unless the
 * user has turned on search history. Personal data and affiliate attribution
 * are kept in separate tables with separate retention (rule 168).
 */
export const ANALYTICS_EVENT_TYPES = [
  'search_submitted',
  'search_completed',
  'search_cancelled',
  'source_mode_changed',
  'filter_applied',
  'sort_changed',
  'result_card_opened',
  'comparison_opened',
  'cheaper_lookup_opened',
  'alternative_lookup_opened',
  'coupon_code_copied',
  'affiliate_link_opened',
  'url_analyzer_submitted',
  'image_analyzer_submitted',
  'alert_created',
  'cart_line_added',
  'empty_state_shown',
  'provider_error_shown',
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

export interface AnalyticsEvent {
  readonly eventId: string;
  readonly type: AnalyticsEventType;
  /** Session-scoped pseudonymous id. Rotated; not joinable to a user. */
  readonly sessionHash: string;
  /** Present only with the user's productAnalytics consent. */
  readonly userId: string | null;
  readonly providerId: ProviderId | null;
  readonly countryCode: string | null;
  readonly deviceType: 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN';
  /** Non-identifying payload. Validated against an allowlist per event type. */
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: string;
}

export interface SearchMetricsSnapshot {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly searches: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly cacheHitRate: number | null;
  readonly zeroResultRate: number | null;
  readonly partialSourceRate: number | null;
}

export interface AffiliateMetricsSnapshot {
  readonly providerId: ProviderId;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly clicks: number;
  readonly uniqueSessions: number;
  readonly clickThroughRate: number | null;
  /** Conversions as reported by the programme. Never inferred from clicks. */
  readonly reportedConversions: number;
  readonly approvedConversions: number;
  readonly reversedConversions: number;
  /** Labelled as an estimate in every surface that renders it. */
  readonly estimatedCommissionMinor: number | null;
  readonly approvedCommissionMinor: number | null;
  readonly commissionCurrency: string | null;
}

/** Properties permitted per event type. Anything else is dropped on ingest. */
export const ALLOWED_EVENT_PROPERTIES: Readonly<
  Record<AnalyticsEventType, ReadonlyArray<string>>
> = {
  search_submitted: ['mode', 'hasBudget', 'queryLength', 'locale'],
  search_completed: ['mode', 'resultCount', 'elapsedMs', 'providersSucceeded', 'cacheHit'],
  search_cancelled: ['mode', 'elapsedMs'],
  source_mode_changed: ['from', 'to'],
  filter_applied: ['filter'],
  sort_changed: ['sort'],
  result_card_opened: ['matchLevel', 'budgetRelation', 'position'],
  comparison_opened: ['providerCount', 'matchLevel'],
  cheaper_lookup_opened: ['matchLevel'],
  alternative_lookup_opened: [],
  coupon_code_copied: ['status'],
  affiliate_link_opened: ['placement', 'matchLevel'],
  url_analyzer_submitted: ['detectedProvider'],
  image_analyzer_submitted: ['confidenceBand'],
  alert_created: ['kind'],
  cart_line_added: ['providerCount'],
  empty_state_shown: ['mode', 'hadFilters'],
  provider_error_shown: ['code'],
};
