'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LinkIcon } from '@/components/ui/Icon';
import { ErrorState } from '@/components/search/EmptyState';
import { ApiError, apiRequest } from '@/lib/api';
import styles from './CheckView.module.css';

/**
 * URL analyzer.
 *
 * Paste a product link and find out what we can establish about it. The
 * interesting answers are the negative ones, and this page is built to deliver
 * them well:
 *
 *   - An unsupported store is named as such rather than failing silently.
 *   - A recognized store whose detail capability is unavailable still reports
 *     the store and the product id — useful information — and says why it
 *     cannot say more.
 *   - A product with no manufacturer identifier is told plainly that it cannot
 *     be compared across stores with confidence, which is the single most
 *     common and most useful finding for a marketplace listing.
 */

interface AnalyzeResponse {
  readonly recognized: boolean;
  readonly reasonKey?: string;
  readonly supportedProviders?: ReadonlyArray<string>;
  readonly providerId?: string;
  readonly providerProductId?: string;
  readonly detailsAvailable?: boolean;
  readonly identityConfidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly comparisonPossible?: boolean;
  readonly product?: { readonly title: string };
}

export function CheckView() {
  const { dict, countryCode, currency } = useLocale();
  const providers = useProviders();

  const [url, setUrl] = useState('');
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = url.trim();
    if (trimmed.length === 0) return;

    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const response = await apiRequest<AnalyzeResponse>('/api/v1/products/analyze-url', {
        method: 'POST',
        body: { url: trimmed, country: countryCode, currency },
      });
      setResult(response);
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-narrow">
      <PageHeader title={dict.check.heading} lead={dict.check.description} />

      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <div className={styles.field}>
          <LinkIcon className={styles.icon} size={18} />
          <input
            className={styles.input}
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={dict.check.placeholder}
            aria-label={dict.check.heading}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            maxLength={2000}
          />
        </div>

        <Button type="submit" variant="primary" size="md" disabled={busy || url.trim().length === 0}>
          {busy ? dict.check.analyzing : dict.check.submit}
        </Button>
      </form>

      <div className={styles.results}>
        {error ? <ErrorState messageKey={error.messageKey} requestId={error.requestId} /> : null}

        {result && !result.recognized ? (
          <div className={styles.panel}>
            <h2 className={styles.panelHeading}>
              {result.reasonKey === 'urlAnalyzer.unsupportedStore'
                ? dict.check.unsupportedStore
                : dict.check.noProductIdInUrl}
            </h2>
            {result.supportedProviders && result.supportedProviders.length > 0 ? (
              <p className={styles.panelText}>
                {result.supportedProviders.map((id) => providers.name(id)).join(' · ')}
              </p>
            ) : null}
          </div>
        ) : null}

        {result?.recognized ? (
          <div className={styles.panel}>
            <div className={styles.panelTop}>
              <Badge tone="source">{providers.name(result.providerId ?? '')}</Badge>
              {result.identityConfidence ? (
                <Badge
                  tone={
                    result.identityConfidence === 'HIGH'
                      ? 'known'
                      : result.identityConfidence === 'MEDIUM'
                        ? 'estimated'
                        : 'unknown'
                  }
                >
                  {dict.check.identityConfidence}: {dict.check.confidence[result.identityConfidence]}
                </Badge>
              ) : null}
            </div>

            {result.product?.title ? (
              <h2 className={styles.panelHeading}>{result.product.title}</h2>
            ) : null}

            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>{dict.check.steps.identifying}</dt>
                <dd className={styles.mono}>{result.providerProductId}</dd>
              </div>
            </dl>

            {result.detailsAvailable === false ? (
              <p className={styles.panelText}>{dict.capability.reasons.VERIFICATION_REQUIRED}</p>
            ) : null}

            {/* The finding that matters most for a marketplace listing. */}
            {result.comparisonPossible === false ? (
              <p className={styles.warning}>{dict.check.comparisonNotPossible}</p>
            ) : null}

            {result.detailsAvailable && result.providerId && result.providerProductId ? (
              <Button
                as="link"
                href={`/product/${encodeURIComponent(result.providerId)}/${encodeURIComponent(
                  result.providerProductId,
                )}`}
                variant="primary"
                size="md"
              >
                {dict.common.details}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
