'use client';

import Link from 'next/link';
import { useState } from 'react';
import { type SearchResultItem, exactValue, formatMoney } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { Badge, SourceBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { CompareIcon, ExternalIcon, ImagePlaceholderMark } from '@/components/ui/Icon';
import { describeMoney, describeShipping, describeTotal, isDemoDatum } from '@/lib/datum';
import { useReveal } from '@/lib/hooks';
import styles from './ResultCard.module.css';

/**
 * Result card.
 *
 * Everything numeric here renders through the Datum describers, which is what
 * makes the card honest without the component having to remember to be:
 *
 *   - An unknown shipping cost prints "shipping cost unknown", not a dash and
 *     not nothing. A blank cell in a price column reads as zero.
 *   - A total built on an unknown component prints as unavailable, with the
 *     missing parts named, rather than silently showing the item price as if
 *     it were the cost.
 *   - "Same model" appears only for an identifier-backed match. An anonymous
 *     listing gets no match badge at all rather than an optimistic one.
 *   - A group found in several stores shows a price row per store underneath,
 *     which is the whole point of the product.
 */

export function ResultCard({
  item,
  position,
  providerNames,
  onOpenStore,
}: {
  readonly item: SearchResultItem;
  readonly position: number;
  readonly providerNames: Readonly<Record<string, string>>;
  readonly onOpenStore: (args: {
    readonly providerId: string;
    readonly providerProductId: string;
    readonly destinationUrl: string;
    readonly productGroupId: string;
  }) => void;
}) {
  const { dict, tag } = useLocale();
  const [explaining, setExplaining] = useState(false);
  const { ref, visible } = useReveal<HTMLElement>();

  const { group } = item;
  const primary =
    group.offerings.find((offering) => offering.providerId === item.primaryProviderId) ??
    group.offerings[0];

  if (!primary) return null;

  const offer = primary.offer;
  const price = describeMoney(offer.price, dict, tag);
  const shipping = describeShipping(offer.shipping.cost, offer.shipping.free, dict, tag);
  const total = describeTotal(
    offer.totalCost.total,
    offer.totalCost.missingComponents,
    dict,
    tag,
  );
  const reference = exactValue(offer.referencePrice);
  const multiStore = group.providerIds.length > 1;

  const productHref = `/product/${encodeURIComponent(primary.providerId)}/${encodeURIComponent(
    offer.providerProductId,
  )}`;

  return (
    <article
      ref={ref}
      className={`${styles.card} reveal`}
      data-visible={visible}
      // A small stagger, capped so the last card in a page of twenty is not
      // waiting two seconds to appear.
      style={{ transitionDelay: `${Math.min(position, 6) * 35}ms` }}
    >
      {item.containsDemoData ? (
        <div className={styles.demoMarker}>
          <Badge tone="estimated">{dict.demo.label}</Badge>
        </div>
      ) : null}

      <div className={styles.imageWrap}>
        {group.primaryImage?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.image}
            src={group.primaryImage.url}
            alt=""
            width={group.primaryImage.width ?? 132}
            height={group.primaryImage.height ?? 132}
            // Below-the-fold cards load lazily; the first few are eager so the
            // top of the results page paints complete.
            loading={position < 3 ? 'eager' : 'lazy'}
            decoding="async"
          />
        ) : (
          <div className={styles.imagePlaceholder} aria-hidden="true">
            <ImagePlaceholderMark />
          </div>
        )}
      </div>

      <div className={styles.body}>
        <div className={styles.topRow}>
          {group.providerIds.map((providerId) => (
            <SourceBadge
              key={providerId}
              displayName={providerNames[providerId] ?? providerId}
              logoPermitted={false}
              logoAssetPath={null}
            />
          ))}

          {/* A match badge only where we can actually claim something. */}
          {item.matchLevel !== 'UNKNOWN' && multiStore ? (
            <Badge tone={item.matchLevel === 'VARIANT_MATCH' ? 'estimated' : 'known'} icon>
              {dict.match.level[item.matchLevel]}
            </Badge>
          ) : null}

          {item.budgetRelation !== 'BUDGET_NOT_STATED' &&
          item.budgetRelation !== 'PRICE_UNKNOWN' ? (
            <Badge
              tone={
                item.budgetRelation === 'WITHIN_BUDGET'
                  ? 'accent'
                  : item.budgetRelation === 'ABOVE_BUDGET'
                    ? 'unknown'
                    : 'neutral'
              }
            >
              {dict.budget[item.budgetRelation]}
            </Badge>
          ) : null}
        </div>

        <h3 className={styles.title}>
          <Link href={productHref} className={styles.titleLink}>
            {group.title}
          </Link>
        </h3>

        <div className={styles.priceRow}>
          <span className={price.hasFigure ? styles.price : styles.priceUnknown}>
            {price.text}
          </span>
          {reference ? (
            <span className={styles.reference}>{formatMoney(reference, tag)}</span>
          ) : null}
        </div>

        <div className={styles.costLines}>
          <div className={styles.costLine}>
            <span className={styles.costLabel}>{dict.price.shipping}</span>
            <span
              className={shipping.hasFigure ? styles.costValue : styles.costValueUnknown}
              title={shipping.detail ?? undefined}
            >
              {shipping.text}
            </span>
          </div>

          <div className={styles.total}>
            <span className={styles.totalLabel}>
              {total.isComplete ? dict.price.total : dict.price.estimatedTotal}
            </span>
            <span className={total.hasFigure ? styles.totalValue : styles.totalUnavailable}>
              {total.text}
            </span>
            {total.missingLabels.length > 0 ? (
              <span className={styles.missing}>
                {dict.price.missingFromTotal}: {total.missingLabels.join(', ')}
              </span>
            ) : null}
          </div>
        </div>

        {multiStore ? (
          <div className={styles.sourceRows}>
            <div className={styles.sourceRowsTitle}>
              {group.comparableAcrossSources
                ? dict.comparison.heading
                : dict.comparison.headingSimilar}
            </div>
            {group.offerings.map((offering) => {
              const rowPrice = describeMoney(offering.offer.price, dict, tag);
              return (
                <div key={`${offering.providerId}-${offering.offer.providerProductId}`} className={styles.sourceRow}>
                  <span className={styles.sourceRowName}>
                    {providerNames[offering.providerId] ?? offering.providerId}
                  </span>
                  <span className={styles.sourceRowPrice}>{rowPrice.text}</span>
                  {/* A variant difference is called out on the row itself, so
                   * two prices never sit side by side implying equivalence. */}
                  <span className={styles.sourceRowNote}>
                    {offering.match.variantConflict
                      ? dict.match.level.VARIANT_MATCH
                      : (rowPrice.note ?? '')}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className={styles.meta}>
          {price.note ? <span>{price.note}</span> : null}
          {price.detail ? <span>{price.detail}</span> : null}
        </div>

        <div className={styles.actions}>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              onOpenStore({
                providerId: primary.providerId,
                providerProductId: offer.providerProductId,
                destinationUrl: offer.sourceUrl,
                productGroupId: group.groupId,
              })
            }
          >
            {dict.product.openInStore(providerNames[primary.providerId] ?? primary.providerId)}
            <ExternalIcon size={15} />
          </Button>

          <Button as="link" href={productHref} variant="secondary" size="sm">
            {dict.common.details}
          </Button>

          {multiStore ? (
            <Button as="link" href={`${productHref}#comparison`} variant="ghost" size="sm">
              <CompareIcon size={15} />
              {dict.common.compare}
            </Button>
          ) : null}

          {item.explanations.length > 0 ? (
            <button
              type="button"
              className={styles.explainButton}
              aria-expanded={explaining}
              onClick={() => setExplaining((open) => !open)}
            >
              {dict.match.explain}
            </button>
          ) : null}
        </div>

        {explaining && item.explanations.length > 0 ? (
          <div className={styles.explainPanel}>
            <ul className={styles.explainList}>
              {item.explanations.map((explanation) => (
                <li key={explanation.key} className={styles.explainItem}>
                  {explanationText(explanation.key, explanation.detail, dict)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Resolves a relevance key to copy.
 *
 * The backend sends keys, not prose, so the explanation is localized and the
 * wording is reviewed here rather than in the ranking code.
 */
function explanationText(
  key: string,
  detail: string | undefined,
  dict: ReturnType<typeof useLocale>['dict'],
): string {
  const leaf = key.replace(/^relevance\./, '') as keyof typeof dict.relevance;
  const text = dict.relevance[leaf];
  if (typeof text !== 'string') return detail ?? key;
  return detail ? `${text}: ${detail}` : text;
}
