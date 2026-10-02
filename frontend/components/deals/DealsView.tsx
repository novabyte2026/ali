'use client';

import { useCallback, useEffect, useState } from 'react';
import { type SourceMode, isSourceMode } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { SourceTabs, buildSourceTabStates } from '@/components/layout/SourceTabs';
import { Badge } from '@/components/ui/Badge';
import { EmptyPanel, ErrorState } from '@/components/search/EmptyState';
import { ApiError, apiRequest } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/datum';
import styles from './DealsView.module.css';

/**
 * Deals page.
 *
 * Every card states the evidence that makes it a deal — a stated discount, a
 * drop against what we recorded, a verified coupon — rather than a generic
 * flame. That is the difference between a deal feed and a sale banner.
 *
 * `endsAt` is rendered only when the store published one, and attributed to
 * the store. There is no countdown timer, no "only 2 left", and no urgency we
 * cannot substantiate (rules 96, 97).
 */

interface DealsResponse {
  readonly mode: string;
  readonly countryCode: string;
  readonly sources: ReadonlyArray<{
    readonly providerId: string;
    readonly available: boolean;
    readonly reasonKey: string | null;
  }>;
  readonly deals: ReadonlyArray<{
    readonly dealId: string;
    readonly providerId: string;
    readonly providerProductId: string;
    readonly evidence: ReadonlyArray<{
      readonly kind: string;
      readonly messageKey: string;
      readonly basis: string | null;
    }>;
    readonly strength: number;
    readonly band: string;
    readonly endsAt: string | null;
    readonly lastConfirmedAt: string;
    readonly containsDemoData: boolean;
  }>;
}

export function DealsView() {
  const { dict, locale, countryCode } = useLocale();
  const providers = useProviders();

  const [mode, setMode] = useState<SourceMode>('all');
  const [data, setData] = useState<DealsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void apiRequest<DealsResponse>('/api/v1/deals', {
      query: { source: mode, country: countryCode },
      signal: controller.signal,
    })
      .then((response) => {
        setData(response);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        if (caught instanceof ApiError) setError(caught);
        setLoading(false);
      });

    return () => controller.abort();
  }, [mode, countryCode]);

  useEffect(() => load(), [load]);

  const tabStates = buildSourceTabStates(
    providers.data?.providers ?? [],
    providers.searchableProviderIds(),
    dict,
  );

  const unavailable = data?.sources.filter((source) => !source.available) ?? [];

  return (
    <div className="page">
      <PageHeader title={dict.deal.heading} />

      <SourceTabs
        states={tabStates}
        active={mode}
        onSelect={(next) => isSourceMode(next) && setMode(next)}
      />

      <div className={styles.body}>
        {error ? (
          <ErrorState messageKey={error.messageKey} requestId={error.requestId} onRetry={load} />
        ) : null}

        {/* Named up front, so a short feed is explained rather than looking
         * like we simply have nothing. */}
        {unavailable.length > 0 ? (
          <p className={styles.sourceNote}>
            {unavailable
              .map(
                (source) =>
                  `${providers.name(source.providerId)}: ${reasonText(source.reasonKey, dict)}`,
              )
              .join(' · ')}
          </p>
        ) : null}

        {loading && !data ? (
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className={`${styles.skeletonCard} skeleton`} />
            ))}
          </div>
        ) : null}

        {data && data.deals.length === 0 && !loading ? (
          <EmptyPanel message={dict.deal.none} />
        ) : null}

        {data && data.deals.length > 0 ? (
          <div className={styles.grid}>
            {data.deals.map((deal) => (
              <article key={deal.dealId} className={styles.card}>
                <div className={styles.cardTop}>
                  <Badge tone="source">{providers.name(deal.providerId)}</Badge>
                  {deal.containsDemoData ? (
                    <Badge tone="estimated">{dict.demo.label}</Badge>
                  ) : null}
                </div>

                <ul className={styles.evidence}>
                  {deal.evidence.map((entry, index) => (
                    <li key={`${entry.kind}-${index}`} className={styles.evidenceItem}>
                      {dict.deal.kind[entry.kind as keyof typeof dict.deal.kind] ?? entry.kind}
                    </li>
                  ))}
                </ul>

                <footer className={styles.cardMeta}>
                  <span>
                    {deal.endsAt
                      ? dict.deal.endsAt(formatDate(deal.endsAt, locale) ?? '')
                      : dict.deal.noEndTime}
                  </span>
                  <span>{relativeTime(deal.lastConfirmedAt, dict)}</span>
                </footer>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function reasonText(reasonKey: string | null, dict: ReturnType<typeof useLocale>['dict']): string {
  if (!reasonKey) return '';
  const state = reasonKey.split('.').pop() ?? '';
  const reason = dict.capability.reasons[state as keyof typeof dict.capability.reasons];
  return typeof reason === 'string' ? reason : '';
}
