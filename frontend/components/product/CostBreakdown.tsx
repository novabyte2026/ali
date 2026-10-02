'use client';

import type { NormalizedOffer } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { Badge } from '@/components/ui/Badge';
import { describeMoney, describeShipping, describeTotal } from '@/lib/datum';
import styles from './CostBreakdown.module.css';

/**
 * Total-cost breakdown.
 *
 * The table that answers "what will this actually cost me". Every line is a
 * Datum, so a line we do not know says so instead of being omitted — an
 * omitted shipping row reads as free shipping, which is the specific
 * misreading this component exists to prevent (rules 13, 46).
 *
 * The total carries its own state. When any component is unknown, the total
 * says the final cost is not available from the source and lists what is
 * missing, rather than quietly presenting the item price as the total.
 */
export function CostBreakdown({ offer }: { readonly offer: NormalizedOffer }) {
  const { dict, tag } = useLocale();

  const itemPrice = describeMoney(offer.price, dict, tag);
  const shipping = describeShipping(offer.shipping.cost, offer.shipping.free, dict, tag);
  const tax = describeMoney(offer.tax.amount, dict, tag);
  const discount = describeMoney(offer.totalCost.discount, dict, tag);
  const couponDiscount = describeMoney(offer.totalCost.couponDiscount, dict, tag);
  const total = describeTotal(
    offer.totalCost.total,
    offer.totalCost.missingComponents,
    dict,
    tag,
  );

  return (
    <div className={styles.panel}>
      <dl className={styles.lines}>
        <Line label={dict.price.itemPrice} value={itemPrice.text} tone={itemPrice.tone} note={itemPrice.note} />

        <Line
          label={dict.price.shipping}
          value={shipping.text}
          tone={shipping.tone}
          note={shipping.detail}
        />

        <Line
          label={offer.tax.appliedRate === null ? dict.price.tax : dict.price.taxEstimated}
          value={tax.text}
          tone={tax.tone}
          note={tax.detail}
        />

        {/* A stated discount only. Absent means the store did not state one,
         * not that there is no discount — so the row is hidden rather than
         * showing "0". */}
        {discount.hasFigure ? (
          <Line label={dict.price.discount} value={`−${discount.text}`} tone="known" note={null} />
        ) : null}

        {couponDiscount.hasFigure ? (
          <Line
            label={dict.price.couponDiscount}
            value={`−${couponDiscount.text}`}
            tone="known"
            note={null}
          />
        ) : null}
      </dl>

      <div className={styles.totalRow}>
        <dt className={styles.totalLabel}>
          {total.isComplete ? dict.price.total : dict.price.estimatedTotal}
        </dt>
        <dd className={styles.totalValue}>
          <span className={total.hasFigure ? styles.totalFigure : styles.totalUnavailable}>
            {total.text}
          </span>
          {total.tone === 'estimated' ? (
            <Badge tone="estimated">{dict.price.estimatedTotal}</Badge>
          ) : null}
        </dd>
      </div>

      {total.missingLabels.length > 0 ? (
        <p className={styles.missing}>
          <strong className={styles.missingLabel}>{dict.price.missingFromTotal}:</strong>{' '}
          {total.missingLabels.join(', ')}
        </p>
      ) : null}

      {total.tone === 'estimated' ? <p className={styles.note}>{dict.price.rangeNote}</p> : null}

      {/* Always present. The store's price at purchase is the one that counts,
       * and saying so is a requirement of at least one of our programmes. */}
      <p className={styles.note}>{dict.price.priceSetByStore}</p>
    </div>
  );
}

function Line({
  label,
  value,
  tone,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: string;
  readonly note: string | null;
}) {
  return (
    <div className={styles.line}>
      <dt className={styles.lineLabel}>{label}</dt>
      <dd className={styles.lineValue}>
        <span
          className={
            tone === 'known'
              ? styles.valueKnown
              : tone === 'estimated'
                ? styles.valueEstimated
                : styles.valueUnknown
          }
        >
          {value}
        </span>
        {note ? <span className={styles.lineNote}>{note}</span> : null}
      </dd>
    </div>
  );
}
