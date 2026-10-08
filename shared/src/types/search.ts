import type { Money } from '../money.js';
import type { MatchLevel } from '../match.js';
import type { ProductGroup } from './product.js';
import type { ProviderAttempt, ProviderId, SourceMode } from './provider.js';
import type { AvailabilityState } from './offer.js';

/**
 * What we understood from the user's words. Produced by search/parser.ts from
 * free text in Hebrew or English, e.g. "אוזניות אלחוטיות עד 150 ₪ עם דירוג 4+".
 *
 * Every field is optional: an unparsed query is a valid query, and we do not
 * invent constraints the user did not state.
 */
export interface QueryIntent {
  /** Text with recognized constraints removed, used as the provider keyword. */
  readonly keywords: string;
  readonly rawQuery: string;
  readonly detectedLanguage: 'he' | 'en' | 'unknown';

  readonly categoryPath?: ReadonlyArray<string>;
  readonly brand?: string;
  readonly model?: string;

  readonly budgetMin?: Money;
  readonly budgetMax?: Money;
  /** True when the user named a ceiling ("עד 120"), which is a hard filter. */
  readonly budgetIsHardLimit: boolean;

  readonly minRating?: number;
  readonly minReviewCount?: number;

  readonly variantHints: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly shippingPreference?: 'FREE_ONLY' | 'FAST' | 'ANY';
  readonly requiresCoupon?: boolean;
  readonly sameProductOnly?: boolean;

  readonly countryCode: string;
  readonly currency: string;
  /** Explicit source the user asked for inside the text ("תחפש גם באלי"). */
  readonly requestedProviderIds: ReadonlyArray<ProviderId>;
  readonly sortPreference?: SortOption;

  /**
   * Constraint tokens we recognized, so the UI can show the user what it
   * understood and let them remove any of it.
   */
  readonly recognized: ReadonlyArray<{
    readonly kind: string;
    readonly text: string;
    readonly valueLabel: string;
  }>;
}

export const SORT_OPTIONS = [
  'MOST_RELEVANT',
  'BEST_MATCH',
  'CLOSEST_TO_BUDGET',
  'LOWEST_OBSERVED_PRICE',
  'LOWEST_ESTIMATED_TOTAL',
  'HIGHEST_RATED',
  'NEWEST_DEALS',
] as const;

export type SortOption = (typeof SORT_OPTIONS)[number];

export interface SearchFilters {
  readonly priceMin?: Money;
  readonly priceMax?: Money;
  readonly providerIds?: ReadonlyArray<ProviderId>;
  readonly brands?: ReadonlyArray<string>;
  readonly minRating?: number;
  readonly minReviewCount?: number;
  readonly freeShippingOnly?: boolean;
  readonly maxDeliveryDays?: number;
  readonly availability?: ReadonlyArray<AvailabilityState>;
  readonly withCouponOnly?: boolean;
  readonly withDealOnly?: boolean;
  /** Restrict to identifier-backed matches for the stated model. */
  readonly exactMatchOnly?: boolean;
  readonly minMatchLevel?: MatchLevel;
  readonly categoryPath?: ReadonlyArray<string>;
  /** Opt-in: show results somewhat above the stated ceiling. */
  readonly allowAboveBudget?: boolean;
}

export interface SearchRequest {
  readonly query: string;
  readonly mode: SourceMode;
  readonly filters: SearchFilters;
  readonly sort: SortOption;
  readonly page: number;
  readonly pageSize: number;
  readonly countryCode: string;
  readonly currency: string;
  readonly locale: string;
}

/** Why a result is in the list, shown in the "why is this here?" popover. */
export interface RelevanceExplanation {
  readonly key: string;
  readonly detail?: string;
}

export type BudgetRelation =
  | 'WITHIN_BUDGET'
  | 'CHEAPER_THAN_BUDGET'
  | 'ABOVE_BUDGET'
  | 'BUDGET_NOT_STATED'
  | 'PRICE_UNKNOWN';

export interface SearchResultItem {
  readonly group: ProductGroup;
  /** Provider offering chosen as the headline for the card. */
  readonly primaryProviderId: ProviderId;
  readonly matchLevel: MatchLevel;
  readonly budgetRelation: BudgetRelation;
  /** 0..1, internal. Never rendered as a number. */
  readonly relevanceScore: number;
  readonly explanations: ReadonlyArray<RelevanceExplanation>;
  /** True when any contributing datum came from a demo fixture. */
  readonly containsDemoData: boolean;
}

export type SearchStage =
  | 'PARSING'
  | 'SELECTING_SOURCES'
  | 'QUERYING_SOURCES'
  | 'NORMALIZING'
  | 'MATCHING'
  | 'PRICING'
  | 'RANKING'
  | 'DONE';

/**
 * Streamed search progress. Every number here reflects work that has actually
 * completed — there is no synthetic percentage that climbs on a timer, which
 * is why the frontend can render it verbatim.
 */
export interface SearchProgressEvent {
  readonly type: 'progress';
  readonly stage: SearchStage;
  readonly attempts: ReadonlyArray<ProviderAttempt>;
  readonly resultsSoFar: number;
  readonly elapsedMs: number;
}

export interface SearchResultsEvent {
  readonly type: 'results';
  /** Incremental batch, appended by the client in arrival order. */
  readonly items: ReadonlyArray<SearchResultItem>;
  readonly replacesPrevious: boolean;
}

export interface SearchDoneEvent {
  readonly type: 'done';
  readonly summary: SearchSummary;
}

export interface SearchErrorEvent {
  readonly type: 'error';
  readonly code: string;
  readonly messageKey: string;
  readonly requestId: string;
}

export type SearchStreamEvent =
  | SearchProgressEvent
  | SearchResultsEvent
  | SearchDoneEvent
  | SearchErrorEvent;

export interface SearchSummary {
  readonly totalResults: number;
  readonly providersQueried: number;
  readonly providersSucceeded: number;
  readonly attempts: ReadonlyArray<ProviderAttempt>;
  readonly intent: QueryIntent;
  readonly appliedFilters: SearchFilters;
  readonly sort: SortOption;
  readonly elapsedMs: number;
  readonly cacheHit: boolean;
  readonly containsDemoData: boolean;
  /** Suggestions shown when the result set is empty or very small. */
  readonly suggestions: ReadonlyArray<{ readonly key: string; readonly value?: string }>;
}

export interface SearchResponse {
  readonly items: ReadonlyArray<SearchResultItem>;
  readonly summary: SearchSummary;
}
