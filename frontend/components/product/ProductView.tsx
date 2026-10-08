'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  type NormalizedOffer,
  type NormalizedProduct,
  type ProductGroup,
  exactValue,
  formatMoney,
} from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { Badge, SourceBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  ArrowLeftIcon,
  ExternalIcon,
  ImagePlaceholderMark,
  StarIcon,
} from '@/components/ui/Icon';
import { ErrorState } from '@/components/search/EmptyState';
import { ApiError, apiRequest, recordAffiliateClick, sendAnalytics } from '@/lib/api';
import { describeMoney, describeShipping, relativeTime } from '@/lib/datum';
import { CostBreakdown } from './CostBreakdown';
import { TrustPanel } from './TrustPanel';
import { ComparisonTable, type ComparisonVerdict } from './ComparisonTable';
import { AffiliateCta } from './AffiliateCta';
import styles from './ProductView.module.css';

/**
 * Product page.
 *
 * Structured the way someone evaluates a purchase: what it is, what it costs
 * in total, whether it is cheaper elsewhere, and how much of that we can
 * actually stand behind.
 *
 * The comparison is fetched separately and after the product, so the page
 * paints with the thing the user asked for rather than waiting on three more
 * provider calls. A comparison that finds nothing says so.
 */

interface ProductResponse {
  readonly product: NormalizedProduct;
  readonly offer: NormalizedOffer;
  readonly provenance: {
    readonly policyVersion: string;
    readonly observedAt: string;
    readonly missingComponents: ReadonlyArray<string>;
    readonly restrictedFields: ReadonlyArray<string>;
  };
  readonly disclosure: {
    readonly required: boolean;
    readonly text: string | null;
    readonly placements: ReadonlyArray<string>;
  };
}

interface ComparisonResponse {
  readonly group: ProductGroup;
  readonly verdict: ComparisonVerdict;
  readonly comparableAsSingleProduct: boolean;
  readonly searchedProviders: ReadonlyArray<string>;
  readonly noMatchReasonKey: string | null;
}

export function ProductView({
  providerId,
  providerProductId,
}: {
  readonly providerId: string;
  readonly providerProductId: string;
}) {
  const { dict, tag, locale, currency, countryCode } = useLocale();
  const providers = useProviders();

  const [data, setData] = useState<ProductResponse | null>(null);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const query = { country: countryCode, currency, locale };

    void apiRequest<ProductResponse>(
      `/api/v1/products/${encodeURIComponent(providerId)}/${encodeURIComponent(providerProductId)}`,
      { query, signal: controller.signal },
    )
      .then((response) => {
        setData(response);
        setLoading(false);

        // Comparison follows the product rather than racing it, so the page
        // is usable before the cross-source search finishes.
        return apiRequest<ComparisonResponse>(
          `/api/v1/products/${encodeURIComponent(providerId)}/${encodeURIComponent(
            providerProductId,
          )}/comparison`,
          { query, signal: controller.signal },
        );
      })
      .then((response) => setComparison(response ?? null))
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === 'AbortError') return;
        if (caught instanceof ApiError && !data) setError(caught);
        setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, providerProductId, countryCode, currency, locale]);

  useEffect(() => load(), [load]);

  const openStore = useCallback(
    async (args: {
      providerId: string;
      providerProductId: string;
      destinationUrl: string;
      placement?: string;
    }) => {
      const tab = window.open('', '_blank', 'noopener,noreferrer');
      try {
        const result = await recordAffiliateClick({
          providerId: args.providerId,
          providerProductId: args.providerProductId,
          destinationUrl: args.destinationUrl,
          placement: args.placement ?? 'PRODUCT_PAGE_PRIMARY',
          locale,
          country: countryCode,
        });
        if (tab) tab.location.href = result.navigateTo;
        else window.location.href = result.navigateTo;
      } catch {
        if (tab) tab.location.href = args.destinationUrl;
        else window.location.href = args.destinationUrl;
      }
    },
    [locale, countryCode],
  );

  useEffect(() => {
    if (!data) return;
    sendAnalytics([
      {
        type: 'result_card_opened',
        providerId,
        properties: { matchLevel: 'UNKNOWN', budgetRelation: 'BUDGET_NOT_STATED', position: 0 },
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (error) {
    return (
      <div className="page" style={{ paddingBlock: 'var(--s-8)' }}>
        <ErrorState messageKey={error.messageKey} requestId={error.requestId} onRetry={load} />
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="page" style={{ paddingBlock: 'var(--s-8)' }}>
        <div className={styles.loadingGrid} aria-hidden="true">
          <div className={`${styles.loadingImage} skeleton`} />
          <div className={styles.loadingBody}>
            <div className={`${styles.loadingLine} skeleton`} />
            <div className={`${styles.loadingLineShort} skeleton`} />
            <div className={`${styles.loadingPrice} skeleton`} />
            <div className={`${styles.loadingPanel} skeleton`} />
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { product, offer, provenance, disclosure } = data;
  const providerName = providers.name(providerId);
  const price = describeMoney(offer.price, dict, tag);
  const shipping = describeShipping(offer.shipping.cost, offer.shipping.free, dict, tag);
  const rating = exactValue(product.rating);
  const reviewCount = exactValue(product.reviewCount);
  const reference = exactValue(offer.referencePrice);
  const brand = exactValue(product.brand);

  return (
    <div className="page">
      <div className={styles.breadcrumb}>
        <Link href="/search" className={styles.backLink}>
          <ArrowLeftIcon size={16} />
          {dict.product.backToResults}
        </Link>
      </div>

      <div className={styles.layout}>
        <div className={styles.media}>
          {product.images[0]?.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className={styles.image}
              src={product.images[0].url}
              alt=""
              width={product.images[0].width ?? 480}
              height={product.images[0].height ?? 480}
              decoding="async"
            />
          ) : (
            <div className={styles.imagePlaceholder} aria-hidden="true">
              <ImagePlaceholderMark size={48} />
            </div>
          )}

          {product.images.length > 1 ? (
            <div className={styles.thumbs}>
              {product.images.slice(1, 5).map((image) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={image.url}
                  className={styles.thumb}
                  src={image.url}
                  alt=""
                  width={64}
                  height={64}
                  loading="lazy"
                  decoding="async"
                />
              ))}
            </div>
          ) : null}
        </div>

        <div className={styles.main}>
          <div className={styles.badgeRow}>
            <SourceBadge displayName={providerName} logoPermitted={false} logoAssetPath={null} />
            {providers.isDemo(providerId) ? (
              <Badge tone="estimated">{dict.demo.label}</Badge>
            ) : null}
          </div>

          <h1 className={styles.title}>{product.title}</h1>

          <dl className={styles.identity}>
            {brand ? (
              <div className={styles.identityRow}>
                <dt>{dict.product.brand}</dt>
                <dd>{brand}</dd>
              </div>
            ) : null}
            {product.identifiers.model ? (
              <div className={styles.identityRow}>
                <dt>{dict.product.model}</dt>
                <dd className={styles.mono}>{product.identifiers.model}</dd>
              </div>
            ) : null}
            {product.identifiers.gtin ? (
              <div className={styles.identityRow}>
                <dt>{dict.product.identifier}</dt>
                <dd className={styles.mono}>{product.identifiers.gtin}</dd>
              </div>
            ) : (
              // Stated rather than omitted: no identifier is why the
              // comparison below may find nothing, and the user should know
              // that before concluding this is the only place it is sold.
              <div className={styles.identityRow}>
                <dt>{dict.product.identifier}</dt>
                <dd className={styles.absent}>{dict.product.noIdentifier}</dd>
              </div>
            )}
          </dl>

          {product.variantAttributes.length > 0 ? (
            <div className={styles.variants}>
              {product.variantAttributes.map((attribute) => (
                <Badge key={attribute.key} tone="neutral">
                  {attribute.raw}
                </Badge>
              ))}
            </div>
          ) : null}

          <div className={styles.priceBlock}>
            <span className={price.hasFigure ? styles.price : styles.priceAbsent}>
              {price.text}
            </span>
            {reference ? (
              <span className={styles.reference}>{formatMoney(reference, tag)}</span>
            ) : null}
            {price.note ? <span className={styles.priceNote}>{price.note}</span> : null}
          </div>

          <div className={styles.ratingRow}>
            {product.rating.state === 'RESTRICTED' ? (
              // The honest version of an empty star row.
              <span className={styles.ratingAbsent}>{dict.product.ratingNotProvided}</span>
            ) : rating !== undefined ? (
              <>
                <span className={styles.ratingStars} aria-hidden="true">
                  {Array.from({ length: 5 }, (_, index) => (
                    <StarIcon key={index} size={15} filled={index < Math.round(rating)} />
                  ))}
                </span>
                <span className={styles.ratingValue}>{rating.toFixed(1)}</span>
                {reviewCount !== undefined ? (
                  <span className={styles.reviewCount}>{dict.product.reviews(reviewCount)}</span>
                ) : null}
              </>
            ) : (
              <span className={styles.ratingAbsent}>{dict.product.noRating}</span>
            )}
          </div>

          <AffiliateCta
            providerId={providerId}
            providerName={providerName}
            destinationUrl={offer.sourceUrl}
            disclosureText={disclosure.text}
            onOpen={() =>
              void openStore({
                providerId,
                providerProductId: offer.providerProductId,
                destinationUrl: offer.sourceUrl,
              })
            }
          />

          <CostBreakdown offer={offer} />

          <TrustPanel
            providerName={providerName}
            observedAt={provenance.observedAt}
            policyVersion={provenance.policyVersion}
            missingComponents={provenance.missingComponents}
            restrictedFields={provenance.restrictedFields}
            containsDemoData={providers.isDemo(providerId)}
          />

          {product.specifications.length > 0 ? (
            <section className={styles.specs}>
              <h2 className={styles.sectionHeading}>{dict.product.specifications}</h2>
              <dl className={styles.specList}>
                {product.specifications.map((spec) => (
                  <div key={spec.key} className={styles.specRow}>
                    <dt className={styles.specLabel}>{spec.label}</dt>
                    <dd className={styles.specValue}>
                      {spec.value}
                      {spec.unit ? ` ${spec.unit}` : ''}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </div>
      </div>

      {comparison ? (
        comparison.group.offerings.length > 1 ? (
          <div className={styles.comparisonWrap}>
            <ComparisonTable
              group={comparison.group}
              verdict={comparison.verdict}
              comparableAsSingleProduct={comparison.comparableAsSingleProduct}
              providerNames={providers.names()}
              onOpenStore={(args) =>
                void openStore({ ...args, placement: 'COMPARISON_ROW' })
              }
            />
          </div>
        ) : (
          <div className={styles.comparisonWrap}>
            <section className={styles.noComparison}>
              <h2 className={styles.sectionHeading}>{dict.comparison.heading}</h2>
              <p className={styles.noComparisonText}>
                {comparison.noMatchReasonKey === 'comparison.productHasNoIdentifiers'
                  ? dict.comparison.productHasNoIdentifiers
                  : comparison.noMatchReasonKey === 'comparison.noIdentifierMatchFound'
                    ? dict.comparison.noMatchFound
                    : dict.comparison.onlyOneSource}
              </p>
              {comparison.searchedProviders.length > 0 ? (
                <p className={styles.noComparisonNote}>
                  {dict.comparison.searchedIn(
                    comparison.searchedProviders.map((id) => providers.name(id)).join(', '),
                  )}
                </p>
              ) : null}
            </section>
          </div>
        )
      ) : null}
    </div>
  );
}
