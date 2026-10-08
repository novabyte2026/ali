'use client';

import type { ProductGroup } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ExternalIcon } from '@/components/ui/Icon';
import { describeDeliveryDays, describeMoney, describeShipping, describeTotal } from '@/lib/datum';
import styles from './ComparisonTable.module.css';

/**
 * Cross-store comparison.
 *
 * The verdict this renders is the product's most important refusal. Given
 * Amazon at 110 with free shipping, Temu at 80 plus 45 shipping, and
 * AliExpress at 72 with shipping unknown, it does not say AliExpress is
 * cheapest. It marks the lowest item price, marks the lowest total *among the
 * rows where a total is known*, and states plainly that the totals are not
 * comparable (rule 28).
 *
 * It also refuses to present rows as one product unless the backend says the
 * group is identifier-backed. A group merged on weaker evidence gets the
 * "similar products" heading instead, so a price column never implies
 * equivalence the matcher did not establish.
 */

export interface ComparisonVerdict {
  readonly lowestItemPriceProviderId: string | null;
  readonly lowestComparableTotalProviderId: string | null;
  readonly incomparableProviderIds: ReadonlyArray<string>;
  readonly totalsFullyComparable: boolean;
  readonly currency: string;
}

export function ComparisonTable({
  group,
  verdict,
  comparableAsSingleProduct,
  providerNames,
  onOpenStore,
}: {
  readonly group: ProductGroup;
  readonly verdict: ComparisonVerdict;
  readonly comparableAsSingleProduct: boolean;
  readonly providerNames: Readonly<Record<string, string>>;
  readonly onOpenStore: (args: {
    readonly providerId: string;
    readonly providerProductId: string;
    readonly destinationUrl: string;
  }) => void;
}) {
  const { dict, tag } = useLocale();

  return (
    <section className={styles.section} id="comparison">
      <div className={styles.header}>
        <h2 className={styles.heading}>
          {comparableAsSingleProduct ? dict.comparison.heading : dict.comparison.headingSimilar}
        </h2>

        {/* The caveat sits above the table, not under it. By the time someone
         * has read the numbers they have already drawn a conclusion. */}
        {!verdict.totalsFullyComparable ? (
          <p className={styles.caveat}>{dict.comparison.cannotCompareTotals}</p>
        ) : null}
      </div>

      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{dict.comparison.store}</th>
              <th scope="col">{dict.comparison.itemPrice}</th>
              <th scope="col">{dict.comparison.shipping}</th>
              <th scope="col">{dict.comparison.estimatedTotal}</th>
              <th scope="col">{dict.comparison.delivery}</th>
              <th scope="col">{dict.comparison.match}</th>
              <th scope="col">
                <span className="visually-hidden">{dict.product.viewInStore}</span>
              </th>
            </tr>
          </thead>

          <tbody>
            {group.offerings.map((offering) => {
              const offer = offering.offer;
              const price = describeMoney(offer.price, dict, tag);
              const shipping = describeShipping(
                offer.shipping.cost,
                offer.shipping.free,
                dict,
                tag,
              );
              const total = describeTotal(
                offer.totalCost.total,
                offer.totalCost.missingComponents,
                dict,
                tag,
              );
              const delivery = describeDeliveryDays(offer.shipping.estimatedDays, dict);

              const isLowestItem = verdict.lowestItemPriceProviderId === offering.providerId;
              const isLowestTotal =
                verdict.totalsFullyComparable &&
                verdict.lowestComparableTotalProviderId === offering.providerId;
              const incomparable = verdict.incomparableProviderIds.includes(offering.providerId);

              return (
                <tr
                  key={`${offering.providerId}-${offer.providerProductId}`}
                  className={incomparable ? styles.rowIncomparable : ''}
                >
                  <th scope="row" className={styles.storeCell}>
                    {providerNames[offering.providerId] ?? offering.providerId}
                  </th>

                  <td className={styles.numericCell}>
                    <span className={price.hasFigure ? styles.figure : styles.absent}>
                      {price.text}
                    </span>
                    {/* Marked, but only as "lowest item price" — which is a
                     * narrower claim than "cheapest". */}
                    {isLowestItem ? (
                      <Badge tone="neutral">{dict.comparison.lowestItemPrice}</Badge>
                    ) : null}
                  </td>

                  <td className={styles.numericCell}>
                    <span className={shipping.hasFigure ? styles.figure : styles.absent}>
                      {shipping.text}
                    </span>
                  </td>

                  <td className={styles.numericCell}>
                    <span className={total.hasFigure ? styles.figure : styles.absent}>
                      {total.text}
                    </span>
                    {isLowestTotal ? (
                      <Badge tone="known">{dict.comparison.lowestTotal}</Badge>
                    ) : null}
                    {total.missingLabels.length > 0 ? (
                      <span className={styles.cellNote}>
                        {dict.price.missingFromTotal}: {total.missingLabels.join(', ')}
                      </span>
                    ) : null}
                  </td>

                  <td className={styles.textCell}>
                    <span className={delivery.hasFigure ? styles.figure : styles.absent}>
                      {delivery.hasFigure ? delivery.text : dict.shipping.notAvailable}
                    </span>
                  </td>

                  <td className={styles.textCell}>
                    {offering.match.variantConflict ? (
                      <Badge tone="estimated">{dict.match.level.VARIANT_MATCH}</Badge>
                    ) : offering.match.level === 'UNKNOWN' ? (
                      <span className={styles.absent}>{dict.match.level.UNKNOWN}</span>
                    ) : (
                      <Badge tone="known">{dict.match.level[offering.match.level]}</Badge>
                    )}
                  </td>

                  <td className={styles.actionCell}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        onOpenStore({
                          providerId: offering.providerId,
                          providerProductId: offer.providerProductId,
                          destinationUrl: offer.sourceUrl,
                        })
                      }
                    >
                      {dict.product.viewInStore}
                      <ExternalIcon size={14} />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* A variant difference anywhere in the group gets its own note, because
       * two rows of the same model at different capacities are the easiest
       * thing on this page to misread. */}
      {group.offerings.some((offering) => offering.match.variantConflict) ? (
        <p className={styles.footnote}>{dict.match.variantDiffers}</p>
      ) : null}

      {!comparableAsSingleProduct ? (
        <p className={styles.footnote}>{dict.match.cannotVerify}</p>
      ) : null}
    </section>
  );
}
