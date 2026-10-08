'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { type SourceMode, isSourceMode } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { SourceTabs, buildSourceTabStates } from '@/components/layout/SourceTabs';
import { Button } from '@/components/ui/Button';
import { CloseIcon, FilterIcon } from '@/components/ui/Icon';
import { recordAffiliateClick, sendAnalytics } from '@/lib/api';
import { useSearchStream } from '@/lib/hooks';
import { SearchBox } from './SearchBox';
import { SearchProgress } from './SearchProgress';
import { ResultCard } from './ResultCard';
import { ResultSkeleton } from './ResultSkeleton';
import { EmptyResults, ErrorState, type Suggestion } from './EmptyState';
import {
  EMPTY_FILTERS,
  FilterPanel,
  SortSelect,
  type FilterValues,
  hasActiveFilters,
} from './FilterPanel';
import styles from './SearchView.module.css';

/**
 * Search view.
 *
 * The URL is the single source of truth for what is being searched, so back
 * and forward work, a link is shareable, and a reload restores the exact view
 * (rules 111, 112, 233, 234). State changes push a URL; the effect that
 * watches the URL runs the search. There is no second copy of the query in
 * component state that could drift from the address bar.
 *
 * Switching source routes does not reload the page. The query and filters
 * carry across, filters that no longer apply are dropped, and the results
 * swap — which is what makes the four routes feel like one product (rule 110).
 */

export function SearchView() {
  const { dict, locale, currency, countryCode } = useLocale();
  const providers = useProviders();
  const router = useRouter();
  const params = useSearchParams();

  const query = params.get('q') ?? '';
  const mode: SourceMode = isSourceMode(params.get('source') ?? '')
    ? (params.get('source') as SourceMode)
    : 'all';
  const sort = params.get('sort') ?? 'MOST_RELEVANT';

  const filters = useMemo<FilterValues>(
    () => ({
      priceMin: params.get('priceMin') ?? '',
      priceMax: params.get('priceMax') ?? '',
      minRating: params.get('minRating') ?? '',
      freeShipping: params.get('freeShipping') === 'true',
      withCoupon: params.get('withCoupon') === 'true',
      exactMatch: params.get('exactMatch') === 'true',
      allowAboveBudget: params.get('allowAboveBudget') === 'true',
    }),
    [params],
  );

  const search = useSearchStream();
  const [drawerOpen, setDrawerOpen] = useState(false);

  /** Writes a new URL. The effect below picks it up and runs the search. */
  const pushState = useCallback(
    (patch: Record<string, string | boolean | undefined>) => {
      const next = new URLSearchParams(params.toString());

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '' || value === false) next.delete(key);
        else next.set(key, String(value));
      }

      next.set('country', countryCode);
      next.set('currency', currency);
      router.push(`/search?${next.toString()}`, { scroll: false });
    },
    [params, router, countryCode, currency],
  );

  // One effect, keyed on the URL. Running the search anywhere else would mean
  // two places that can start one.
  useEffect(() => {
    if (query.trim().length === 0) return;

    void search.run({
      q: query,
      source: mode,
      country: countryCode,
      currency,
      locale,
      sort,
      ...(filters.priceMin ? { priceMin: filters.priceMin } : {}),
      ...(filters.priceMax ? { priceMax: filters.priceMax } : {}),
      ...(filters.minRating ? { minRating: filters.minRating } : {}),
      ...(filters.freeShipping ? { freeShipping: true } : {}),
      ...(filters.withCoupon ? { withCoupon: true } : {}),
      ...(filters.exactMatch ? { exactMatch: true } : {}),
      ...(filters.allowAboveBudget ? { allowAboveBudget: true } : {}),
    });

    sendAnalytics([
      {
        type: 'search_submitted',
        properties: {
          mode,
          hasBudget: filters.priceMax !== '',
          queryLength: query.length,
          locale,
        },
      },
    ]);
    // `search.run` is stable from the hook; including it would re-fire on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode, sort, filters, countryCode, currency, locale]);

  useEffect(() => {
    if (!search.summary) return;
    sendAnalytics([
      {
        type: 'search_completed',
        properties: {
          mode,
          resultCount: search.summary.totalResults,
          elapsedMs: search.summary.elapsedMs,
          providersSucceeded: search.summary.providersSucceeded,
          cacheHit: search.summary.cacheHit,
        },
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.summary]);

  const openStore = useCallback(
    async (args: {
      providerId: string;
      providerProductId: string;
      destinationUrl: string;
      productGroupId: string;
    }) => {
      // Open the tab before awaiting, so the navigation is still inside the
      // user's gesture and does not get blocked as a popup.
      const tab = window.open('', '_blank', 'noopener,noreferrer');

      try {
        const result = await recordAffiliateClick({
          ...args,
          placement: 'SEARCH_RESULT',
          locale,
          country: countryCode,
        });
        if (tab) tab.location.href = result.navigateTo;
        else window.location.href = result.navigateTo;
      } catch {
        // If the click could not be recorded we still send the user to the
        // store. Losing attribution is better than a dead button.
        if (tab) tab.location.href = args.destinationUrl;
        else window.location.href = args.destinationUrl;
      }
    },
    [locale, countryCode],
  );

  const applySuggestion = (suggestion: Suggestion): void => {
    switch (suggestion.key) {
      case 'suggestion.raiseBudget':
        pushState({ priceMax: suggestion.value, allowAboveBudget: undefined });
        break;
      case 'suggestion.removeRatingFilter':
        pushState({ minRating: undefined });
        break;
      case 'suggestion.removeFreeShippingFilter':
        pushState({ freeShipping: undefined });
        break;
      case 'suggestion.removeCouponFilter':
        pushState({ withCoupon: undefined });
        break;
      case 'suggestion.allowSimilarProducts':
        pushState({ exactMatch: undefined });
        break;
      case 'suggestion.searchAllSources':
        pushState({ source: 'all' });
        break;
      case 'suggestion.retryUnavailableSources':
        void search.run({ q: query, source: mode, country: countryCode, currency, locale, sort });
        break;
      case 'suggestion.searchWithoutModel':
        if (suggestion.value) {
          pushState({ q: query.replace(suggestion.value, '').trim() });
        }
        break;
    }
  };

  const tabStates = buildSourceTabStates(
    providers.data?.providers ?? [],
    providers.searchableProviderIds(),
    dict,
  );

  const activeProviderIds =
    mode === 'all'
      ? providers.searchableProviderIds()
      : providers.searchableProviderIds().filter((id) => id === mode);

  const succeeded = search.attempts.filter(
    (attempt) => attempt.status === 'OK' || attempt.status === 'EMPTY',
  ).length;
  const partialSources = search.attempts.length > 0 && succeeded < search.attempts.length;

  const showProgress = search.running || partialSources;
  const showSkeleton = search.running && search.items.length === 0;

  return (
    <div className="page">
      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label={dict.search.filtersLabel}>
          <FilterPanel
            values={filters}
            activeProviderIds={activeProviderIds}
            onChange={(patch) => pushState(patch as Record<string, string | boolean | undefined>)}
            onClear={() =>
              pushState({
                priceMin: undefined,
                priceMax: undefined,
                minRating: undefined,
                freeShipping: undefined,
                withCoupon: undefined,
                exactMatch: undefined,
                allowAboveBudget: undefined,
              })
            }
          />
        </aside>

        <div className={styles.main}>
          <div className={styles.searchRow}>
            <SearchBox
              initialQuery={query}
              intent={search.summary?.intent ?? null}
              onSubmit={(next) => pushState({ q: next })}
              onRemoveConstraint={(text) =>
                pushState({ q: query.replace(text, '').replace(/\s{2,}/g, ' ').trim() })
              }
            />

            <SourceTabs
              states={tabStates}
              active={mode}
              onSelect={(nextMode) => pushState({ source: nextMode })}
            />
          </div>

          <div className={styles.toolbar}>
            {search.summary ? (
              <span className={styles.resultCount}>
                {dict.search.resultCount(search.summary.totalResults)}
              </span>
            ) : null}

            {search.attempts.length > 0 ? (
              <span
                className={`${styles.sourceNote} ${partialSources ? styles.sourceNoteWarning : ''}`}
              >
                {dict.search.sourcesAvailable(succeeded, search.attempts.length)}
              </span>
            ) : null}

            <div className={styles.toolbarActions}>
              <Button
                variant="secondary"
                size="sm"
                className={styles.mobileFilterButton}
                onClick={() => setDrawerOpen(true)}
              >
                <FilterIcon size={15} />
                {dict.search.showFilters}
                {hasActiveFilters(filters) ? ' ·' : ''}
              </Button>

              <SortSelect
                value={sort}
                className={styles.select}
                onChange={(next) => pushState({ sort: next })}
              />
            </div>
          </div>

          {showProgress ? (
            <SearchProgress
              stage={search.stage}
              attempts={search.attempts}
              elapsedMs={search.elapsedMs}
              resultsSoFar={search.resultsSoFar}
              running={search.running}
              providerNames={providers.names()}
              onCancel={search.cancel}
            />
          ) : null}

          {search.error ? (
            <ErrorState
              messageKey={search.error.messageKey}
              requestId={search.error.requestId}
              onRetry={() =>
                void search.run({ q: query, source: mode, country: countryCode, currency, locale, sort })
              }
            />
          ) : null}

          {showSkeleton ? <ResultSkeleton count={4} /> : null}

          {search.items.length > 0 ? (
            <div className={styles.results}>
              {search.items.map((item, index) => (
                <ResultCard
                  key={item.group.groupId}
                  item={item}
                  position={index}
                  providerNames={providers.names()}
                  onOpenStore={(args) => void openStore(args)}
                />
              ))}
            </div>
          ) : null}

          {!search.running && !search.error && search.summary && search.items.length === 0 ? (
            <EmptyResults
              suggestions={search.summary.suggestions as ReadonlyArray<Suggestion>}
              onSuggestion={applySuggestion}
              onSearchAll={() => pushState({ source: 'all' })}
            />
          ) : null}
        </div>
      </div>

      {drawerOpen ? (
        <>
          <div
            className={styles.drawerBackdrop}
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-label={dict.search.filtersLabel}>
            <div className={styles.drawerHeader}>
              <span className={styles.drawerTitle}>{dict.search.filtersLabel}</span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={dict.common.close}
                onClick={() => setDrawerOpen(false)}
              >
                <CloseIcon />
              </Button>
            </div>

            <FilterPanel
              values={filters}
              activeProviderIds={activeProviderIds}
              onChange={(patch) => pushState(patch as Record<string, string | boolean | undefined>)}
              onClear={() =>
                pushState({
                  priceMin: undefined,
                  priceMax: undefined,
                  minRating: undefined,
                  freeShipping: undefined,
                  withCoupon: undefined,
                  exactMatch: undefined,
                  allowAboveBudget: undefined,
                })
              }
            />

            <div className={styles.drawerFooter}>
              <Button variant="primary" size="md" block onClick={() => setDrawerOpen(false)}>
                {dict.search.hideFilters}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
