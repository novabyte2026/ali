import {
  type ProviderAttempt,
  type QueryIntent,
  type SearchFilters,
  type SearchRequest,
  type SearchResultItem,
  type SearchStage,
  type SearchStreamEvent,
  type SearchSummary,
  exactValue,
  fingerprint,
  searchCacheKey,
} from '@shelf/shared';
import {
  type AdapterContext,
  type AdapterSearchResult,
  type RegistryEntry,
  isFailure,
  isRefusal,
} from '@shelf/integrations';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';
import type { Cache } from '../cache/index.js';
import type { ComplianceGuardFactory, ProviderGuard } from '../compliance/guard.js';
import type { CurrencyConverter } from '../pricing/currency.js';
import { priceOffer } from '../pricing/engine.js';
import { groupListings } from '../products/grouping.js';
import { applyHardFilters, rankGroups } from './ranking.js';
import { intentToFilters, parseQuery } from './parser.js';
import type { ProviderHealthTracker } from '../providers/health.js';
import type { CouponStore } from '../coupons/store.js';
import { selectCouponsForOffer } from '../coupons/engine.js';

/**
 * The search aggregator.
 *
 * Runs the pipeline from rule 89: parse, select sources, query in parallel,
 * normalize, match, price, rank, stream. Three properties matter more than the
 * individual steps.
 *
 * Partial failure is a first-class outcome. If Temu does not answer, the user
 * gets Amazon and AliExpress plus an honest note that one of three sources did
 * not respond. One source being down never takes the search down (rules 76,
 * 77).
 *
 * Progress is real. Every event this emits describes work that has actually
 * completed — a provider moving from RUNNING to OK, a count of results merged.
 * There is no timer-driven percentage anywhere in this file, because a fake
 * progress bar that sits at 96% is worse than no progress bar (rule 47).
 *
 * Cancellation is honoured. A user who retypes aborts the previous search's
 * provider calls rather than leaving them to finish and bill against quota.
 */

export interface AggregatorDeps {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly cache: Cache;
  readonly guards: ComplianceGuardFactory;
  readonly converter: CurrencyConverter;
  readonly registry: ReadonlyArray<RegistryEntry>;
  readonly health: ProviderHealthTracker;
  readonly coupons: CouponStore;
}

export interface AggregateOptions {
  readonly request: SearchRequest;
  readonly requestId: string;
  readonly signal: AbortSignal;
  /** Resolved at request time: enabled, configured, search-permitted. */
  readonly providerIds: ReadonlyArray<string>;
  readonly onEvent?: (event: SearchStreamEvent) => void;
}

export interface AggregateResult {
  readonly items: ReadonlyArray<SearchResultItem>;
  readonly summary: SearchSummary;
}

export async function aggregateSearch(
  deps: AggregatorDeps,
  options: AggregateOptions,
): Promise<AggregateResult> {
  const startedAt = Date.now();
  const { request } = options;
  const emit = options.onEvent ?? (() => {});

  // --- Stage 1: parse ------------------------------------------------------
  const intent = parseQuery(request.query, {
    countryCode: request.countryCode,
    currency: request.currency,
    locale: request.locale,
    knownProviderIds: options.providerIds,
  });

  // A source named inside the query narrows the search, but only to providers
  // the route already allows — typing "amazon" while in the Temu tab does not
  // escape the tab.
  const requestedInText = intent.requestedProviderIds.filter((id) =>
    options.providerIds.includes(id),
  );
  const targetProviderIds = requestedInText.length > 0 ? requestedInText : options.providerIds;

  const filters: SearchFilters = { ...intentToFilters(intent), ...request.filters };
  const sort = request.filters.allowAboveBudget ? request.sort : (intent.sortPreference ?? request.sort);

  const attempts = new Map<string, ProviderAttempt>(
    targetProviderIds.map((providerId) => [
      providerId,
      { providerId, status: 'PENDING', durationMs: null, resultCount: 0, reason: null },
    ]),
  );

  emitProgress(emit, 'PARSING', attempts, 0, startedAt);

  // --- Cache --------------------------------------------------------------
  const cacheKey = searchCacheKey({
    query: intent.keywords,
    providerIds: targetProviderIds,
    countryCode: request.countryCode,
    currency: request.currency,
    filtersFingerprint: fingerprint(filters),
    sort,
    page: request.page,
  });

  const cached = await deps.cache.get<AggregateResult>(cacheKey);
  if (cached) {
    emit({ type: 'results', items: cached.items, replacesPrevious: true });
    const summary = { ...cached.summary, cacheHit: true, elapsedMs: Date.now() - startedAt };
    emit({ type: 'done', summary });
    return { items: cached.items, summary };
  }

  emitProgress(emit, 'SELECTING_SOURCES', attempts, 0, startedAt);

  // --- Stage 2: guards ----------------------------------------------------
  const guards = await deps.guards.forProviders(targetProviderIds, request.locale);

  // --- Stage 3: query providers in parallel -------------------------------
  emitProgress(emit, 'QUERYING_SOURCES', attempts, 0, startedAt);

  // One overall budget: a slow provider must not hold the page open past it.
  const totalBudget = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(deps.config.search.totalTimeoutMs),
  ]);

  const collected: Array<{
    providerId: string;
    result: AdapterSearchResult;
    demoFixture: boolean;
  }> = [];

  const tasks = targetProviderIds.map(async (providerId) => {
    const entry = deps.registry.find((candidate) => candidate.providerId === providerId);
    const guard = guards.get(providerId);
    if (!entry || !guard) {
      attempts.set(providerId, {
        providerId,
        status: 'SKIPPED',
        durationMs: null,
        resultCount: 0,
        reason: 'ERROR_UNSUPPORTED_SOURCE',
      });
      return;
    }

    attempts.set(providerId, {
      providerId,
      status: 'RUNNING',
      durationMs: null,
      resultCount: 0,
      reason: null,
    });
    emitProgress(emit, 'QUERYING_SOURCES', attempts, collected.length, startedAt);

    const ctx: AdapterContext = {
      guard: guard.withRequestId(options.requestId),
      countryCode: request.countryCode,
      currency: request.currency,
      locale: request.locale,
      requestId: options.requestId,
      signal: totalBudget,
      log: deps.log.child({ providerId }),
    };

    const startedProviderAt = Date.now();
    const outcome = await entry.adapter.searchProducts(
      {
        keywords: intent.keywords,
        ...(intent.brand ? { brand: intent.brand } : {}),
        ...(intent.categoryPath ? { categoryPath: intent.categoryPath } : {}),
        ...(filters.priceMin ? { priceMinMinor: filters.priceMin.minor } : {}),
        ...(filters.priceMax ? { priceMaxMinor: filters.priceMax.minor } : {}),
        ...(filters.minRating === undefined ? {} : { minRating: filters.minRating }),
        page: request.page,
        pageSize: Math.min(request.pageSize, deps.config.search.maxPageSize),
        sort: adapterSortFor(sort),
      },
      ctx,
    );

    const durationMs = Date.now() - startedProviderAt;
    deps.health.record(providerId, {
      operation: 'searchProducts',
      durationMs,
      status: outcome.ok ? 'OK' : isRefusal(outcome) ? 'CIRCUIT_OPEN' : 'FAILED',
      ...(isFailure(outcome) ? { errorCode: outcome.failure.code } : {}),
      rateLimited: outcome.meta.rateLimited,
      requestId: options.requestId,
    });

    if (!outcome.ok) {
      // A refusal and a failure look different to the user: one says this
      // source does not offer the feature, the other says it did not answer.
      const reason = isRefusal(outcome) ? outcome.refusal.code : outcome.failure.code;
      attempts.set(providerId, {
        providerId,
        status: isRefusal(outcome) ? 'SKIPPED' : 'FAILED',
        durationMs,
        resultCount: 0,
        reason,
      });
      emitProgress(emit, 'QUERYING_SOURCES', attempts, collected.length, startedAt);
      return;
    }

    collected.push({
      providerId,
      result: outcome.value,
      demoFixture: outcome.meta.demoFixture,
    });

    attempts.set(providerId, {
      providerId,
      status: outcome.value.items.length === 0 ? 'EMPTY' : 'OK',
      durationMs,
      resultCount: outcome.value.items.length,
      reason: null,
    });
    emitProgress(emit, 'NORMALIZING', attempts, countItems(collected), startedAt);
  });

  await Promise.allSettled(tasks);

  // --- Stage 4: price, coupon, group, rank --------------------------------
  emitProgress(emit, 'PRICING', attempts, countItems(collected), startedAt);

  const couponsByProvider = await loadCoupons(deps, targetProviderIds, guards, request);

  const priced: Array<{ product: AdapterSearchResult['items'][number]['product']; offer: AdapterSearchResult['items'][number]['offer'] }> = [];

  for (const batch of collected) {
    const guard = guards.get(batch.providerId);
    if (!guard) continue;

    for (const item of batch.result.items) {
      const providerCoupons = couponsByProvider.get(batch.providerId) ?? [];
      const applicable = selectCouponsForOffer(providerCoupons, item.offer, {
        countryCode: request.countryCode,
      });

      const offer = await priceOffer(item.offer, {
        targetCurrency: request.currency,
        countryCode: request.countryCode,
        guard,
        converter: deps.converter,
        appliedCoupons: applicable,
      });

      priced.push({ product: item.product, offer });
    }
  }

  emitProgress(emit, 'MATCHING', attempts, priced.length, startedAt);

  const crossProviderAllowed = new Set<string>();
  for (const [providerId, guard] of guards) {
    if (guard.crossProviderDisplayPermitted()) crossProviderAllowed.add(providerId);
  }

  const groups = groupListings(priced, { crossProviderAllowed });

  emitProgress(emit, 'RANKING', attempts, groups.length, startedAt);

  const filtered = applyHardFilters(groups, filters, intent);
  const items = rankGroups(filtered, {
    intent,
    filters,
    sort,
    now: new Date(),
    providerReliability: deps.health.reliabilityMap(),
  });

  const attemptList = [...attempts.values()];
  const summary: SearchSummary = {
    totalResults: items.length,
    providersQueried: attemptList.length,
    providersSucceeded: attemptList.filter(
      (attempt) => attempt.status === 'OK' || attempt.status === 'EMPTY',
    ).length,
    attempts: attemptList,
    intent,
    appliedFilters: filters,
    sort,
    elapsedMs: Date.now() - startedAt,
    cacheHit: false,
    containsDemoData: collected.some((batch) => batch.demoFixture),
    suggestions: buildSuggestions({ items, intent, filters, attempts: attemptList }),
  };

  emit({ type: 'results', items, replacesPrevious: true });
  emit({ type: 'done', summary });

  // --- Cache --------------------------------------------------------------
  // TTL is the minimum of our own preference and what every contributing
  // provider's policy permits. A provider whose policy forbids caching makes
  // the whole response uncacheable, because the response contains its data.
  const ttl = resolveCacheTtl(guards, collected.map((batch) => batch.providerId));
  if (ttl > 0 && !summary.containsDemoData && items.length > 0) {
    await deps.cache.set(cacheKey, { items, summary }, ttl);
  }

  return { items, summary };
}

/** Lowest permitted TTL across the providers that contributed data. */
function resolveCacheTtl(
  guards: ReadonlyMap<string, ProviderGuard>,
  contributingProviderIds: ReadonlyArray<string>,
): number {
  const desired = 120;
  let ttl = desired;
  for (const providerId of contributingProviderIds) {
    const guard = guards.get(providerId);
    if (!guard) continue;
    const permitted = guard.effectiveCacheSeconds(desired);
    if (permitted <= 0) return 0;
    ttl = Math.min(ttl, permitted);
  }
  return ttl;
}

async function loadCoupons(
  deps: AggregatorDeps,
  providerIds: ReadonlyArray<string>,
  guards: ReadonlyMap<string, ProviderGuard>,
  request: SearchRequest,
) {
  const out = new Map<string, Awaited<ReturnType<CouponStore['activeForProvider']>>>();
  for (const providerId of providerIds) {
    const guard = guards.get(providerId);
    // No coupon capability means no coupon lookup at all, rather than a lookup
    // whose results we then discard.
    if (!guard || !guard.check('coupons').allowed) continue;
    try {
      out.set(
        providerId,
        await deps.coupons.activeForProvider(providerId, request.countryCode),
      );
    } catch (error) {
      deps.log.warn('Coupon lookup failed', { providerId, error });
    }
  }
  return out;
}

function emitProgress(
  emit: (event: SearchStreamEvent) => void,
  stage: SearchStage,
  attempts: ReadonlyMap<string, ProviderAttempt>,
  resultsSoFar: number,
  startedAt: number,
): void {
  emit({
    type: 'progress',
    stage,
    attempts: [...attempts.values()],
    resultsSoFar,
    elapsedMs: Date.now() - startedAt,
  });
}

function countItems(
  collected: ReadonlyArray<{ readonly result: AdapterSearchResult }>,
): number {
  return collected.reduce((total, batch) => total + batch.result.items.length, 0);
}

function adapterSortFor(
  sort: SearchRequest['sort'],
): 'RELEVANCE' | 'PRICE_ASC' | 'PRICE_DESC' | 'RATING_DESC' | 'NEWEST' | undefined {
  switch (sort) {
    case 'LOWEST_OBSERVED_PRICE':
    case 'LOWEST_ESTIMATED_TOTAL':
      return 'PRICE_ASC';
    case 'HIGHEST_RATED':
      return 'RATING_DESC';
    case 'NEWEST_DEALS':
      return 'NEWEST';
    case 'MOST_RELEVANT':
    case 'BEST_MATCH':
      return 'RELEVANCE';
    default:
      return undefined;
  }
}

/**
 * Suggestions for a thin or empty result set.
 *
 * Each one is actionable and specific to why the set is thin — a removed
 * filter, a widened budget, a different route (rules 78, 274). A generic
 * "try another search" is not a suggestion.
 */
function buildSuggestions(args: {
  readonly items: ReadonlyArray<SearchResultItem>;
  readonly intent: QueryIntent;
  readonly filters: SearchFilters;
  readonly attempts: ReadonlyArray<ProviderAttempt>;
}): ReadonlyArray<{ readonly key: string; readonly value?: string }> {
  if (args.items.length >= 6) return [];

  const suggestions: Array<{ key: string; value?: string }> = [];

  const budget = args.filters.priceMax ?? args.intent.budgetMax;
  if (budget) {
    suggestions.push({
      key: 'suggestion.raiseBudget',
      value: String(Math.round((budget.minor * 1.35) / 100)),
    });
  }

  if (args.filters.minRating !== undefined) {
    suggestions.push({ key: 'suggestion.removeRatingFilter' });
  }
  if (args.filters.freeShippingOnly) {
    suggestions.push({ key: 'suggestion.removeFreeShippingFilter' });
  }
  if (args.filters.withCouponOnly) {
    suggestions.push({ key: 'suggestion.removeCouponFilter' });
  }
  if (args.filters.exactMatchOnly) {
    suggestions.push({ key: 'suggestion.allowSimilarProducts' });
  }

  // A thin result set caused by sources not answering is a different problem
  // from a thin result set caused by filters, and the suggestion says so.
  const unavailable = args.attempts.filter(
    (attempt) => attempt.status === 'FAILED' || attempt.status === 'SKIPPED',
  );
  if (unavailable.length > 0) {
    suggestions.push({
      key: 'suggestion.retryUnavailableSources',
      value: String(unavailable.length),
    });
  }

  if (args.attempts.length === 1) {
    suggestions.push({ key: 'suggestion.searchAllSources' });
  }

  if (args.intent.model) {
    suggestions.push({ key: 'suggestion.searchWithoutModel', value: args.intent.model });
  }

  return suggestions.slice(0, 3);
}

/** Price of the headline offering, for logging and telemetry. */
export function headlinePriceMinor(item: SearchResultItem): number | null {
  const offering = item.group.offerings.find(
    (entry) => entry.providerId === item.primaryProviderId,
  );
  return exactValue(offering?.offer.price)?.minor ?? null;
}
