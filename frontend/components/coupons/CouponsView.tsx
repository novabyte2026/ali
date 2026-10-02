'use client';

import { useCallback, useEffect, useState } from 'react';
import { type SourceMode, isSourceMode } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { SourceTabs, buildSourceTabStates } from '@/components/layout/SourceTabs';
import { EmptyPanel, ErrorState } from '@/components/search/EmptyState';
import { ApiError, apiRequest } from '@/lib/api';
import { CouponCard, type CouponWithTrust } from './CouponCard';
import styles from './CouponsView.module.css';

/**
 * Coupons page.
 *
 * The important behaviour is what it does for a source whose coupon capability
 * is not available: it says so, naming the source, instead of showing an empty
 * grid. An empty grid reads as "this store has no coupons", which is a claim
 * we have no basis for (rule 288).
 */

interface CouponsResponse {
  readonly mode: string;
  readonly countryCode: string;
  readonly sources: ReadonlyArray<{
    readonly providerId: string;
    readonly available: boolean;
    readonly reasonKey: string | null;
    readonly coupons: ReadonlyArray<CouponWithTrust>;
  }>;
  readonly totalPresentable: number;
  readonly anySourceUnavailable: boolean;
}

export function CouponsView() {
  const { dict, countryCode } = useLocale();
  const providers = useProviders();

  const [mode, setMode] = useState<SourceMode>('all');
  const [data, setData] = useState<CouponsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void apiRequest<CouponsResponse>('/api/v1/coupons', {
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

  return (
    <div className="page">
      <PageHeader title={dict.coupon.heading} />

      <SourceTabs
        states={tabStates}
        active={mode}
        onSelect={(next) => isSourceMode(next) && setMode(next)}
      />

      <div className={styles.body}>
        {error ? (
          <ErrorState messageKey={error.messageKey} requestId={error.requestId} onRetry={load} />
        ) : null}

        {loading && !data ? (
          <div className={styles.grid} aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className={`${styles.skeletonCard} skeleton`} />
            ))}
          </div>
        ) : null}

        {data?.sources.map((source) => (
          <section key={source.providerId} className={styles.sourceSection}>
            <h2 className={styles.sourceHeading}>{providers.name(source.providerId)}</h2>

            {!source.available ? (
              // The specific reason, not a blank space.
              <EmptyPanel
                message={`${dict.coupon.sourceUnavailable} ${reasonText(source.reasonKey, dict)}`}
              />
            ) : source.coupons.length === 0 ? (
              <EmptyPanel message={dict.coupon.none} />
            ) : (
              <div className={styles.grid}>
                {source.coupons.map((coupon) => (
                  <CouponCard
                    key={coupon.couponId}
                    coupon={coupon}
                    providerName={providers.name(source.providerId)}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function reasonText(
  reasonKey: string | null,
  dict: ReturnType<typeof useLocale>['dict'],
): string {
  if (!reasonKey) return '';
  const state = reasonKey.split('.').pop() ?? '';
  const reason = dict.capability.reasons[state as keyof typeof dict.capability.reasons];
  return typeof reason === 'string' ? reason : '';
}
