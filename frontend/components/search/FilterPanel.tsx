'use client';

import { SORT_OPTIONS } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { Button } from '@/components/ui/Button';
import styles from './FilterPanel.module.css';

/**
 * Filter panel.
 *
 * Two things here are not cosmetic.
 *
 * Capability-aware filters: the coupon filter is only offered when at least one
 * searchable source can actually supply coupons, because a filter that cannot
 * match anything is worse than no filter — the user applies it, gets nothing,
 * and concludes the product is broken rather than that the data is missing.
 *
 * Honest filter notes: "free shipping only" says it matches only listings
 * where the store states it explicitly. Without that note a user would assume
 * the filter is exhaustive, when in fact most listings simply do not say.
 */

export interface FilterValues {
  readonly priceMin: string;
  readonly priceMax: string;
  readonly minRating: string;
  readonly freeShipping: boolean;
  readonly withCoupon: boolean;
  readonly exactMatch: boolean;
  readonly allowAboveBudget: boolean;
}

export const EMPTY_FILTERS: FilterValues = {
  priceMin: '',
  priceMax: '',
  minRating: '',
  freeShipping: false,
  withCoupon: false,
  exactMatch: false,
  allowAboveBudget: false,
};

export function hasActiveFilters(values: FilterValues): boolean {
  return (
    values.priceMin !== '' ||
    values.priceMax !== '' ||
    values.minRating !== '' ||
    values.freeShipping ||
    values.withCoupon ||
    values.exactMatch ||
    values.allowAboveBudget
  );
}

export function FilterPanel({
  values,
  onChange,
  onClear,
  activeProviderIds,
}: {
  readonly values: FilterValues;
  readonly onChange: (patch: Partial<FilterValues>) => void;
  readonly onClear: () => void;
  readonly activeProviderIds: ReadonlyArray<string>;
}) {
  const { dict, currency } = useLocale();
  const providers = useProviders();

  // Offered only where a source can supply the data behind it.
  const couponFilterUseful = activeProviderIds.some((id) => providers.can(id, 'coupons'));
  const shippingFilterUseful = activeProviderIds.some((id) => providers.can(id, 'shipping'));
  const ratingFilterUseful = activeProviderIds.some((id) => providers.can(id, 'ratings'));

  return (
    <div className={styles.panel}>
      <section className={styles.group}>
        <h3 className={styles.groupTitle}>
          {dict.filters.price} <span className={styles.currency}>{currency}</span>
        </h3>
        <div className={styles.priceRow}>
          <label className={styles.priceField}>
            <span className={styles.priceLabel}>{dict.filters.priceFrom}</span>
            <input
              className={styles.input}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={values.priceMin}
              onChange={(event) => onChange({ priceMin: event.target.value })}
            />
          </label>
          <label className={styles.priceField}>
            <span className={styles.priceLabel}>{dict.filters.priceTo}</span>
            <input
              className={styles.input}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={values.priceMax}
              onChange={(event) => onChange({ priceMax: event.target.value })}
            />
          </label>
        </div>

        {/* Opt-in escape hatch for a stated ceiling. The ceiling is a hard
         * filter by default; this is the only way past it (rule 231). */}
        {values.priceMax !== '' ? (
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={values.allowAboveBudget}
              onChange={(event) => onChange({ allowAboveBudget: event.target.checked })}
            />
            <span>{dict.filters.allowAboveBudget}</span>
          </label>
        ) : null}
      </section>

      {ratingFilterUseful ? (
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{dict.filters.rating}</h3>
          <div className={styles.chipRow}>
            {['4.5', '4', '3.5'].map((threshold) => (
              <button
                key={threshold}
                type="button"
                className={`${styles.chip} ${values.minRating === threshold ? styles.chipActive : ''}`}
                onClick={() =>
                  onChange({ minRating: values.minRating === threshold ? '' : threshold })
                }
              >
                {dict.filters.minRating(Number.parseFloat(threshold))}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className={styles.group}>
        <h3 className={styles.groupTitle}>{dict.filters.shipping}</h3>

        {shippingFilterUseful ? (
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={values.freeShipping}
              onChange={(event) => onChange({ freeShipping: event.target.checked })}
            />
            <span>
              {dict.filters.freeShippingOnly}
              {/* The honest caveat, inline rather than in a tooltip. */}
              <span className={styles.note}>{dict.filters.freeShippingNote}</span>
            </span>
          </label>
        ) : (
          <p className={styles.unavailableNote}>{dict.capability.reasons.VERIFICATION_REQUIRED}</p>
        )}
      </section>

      <section className={styles.group}>
        <h3 className={styles.groupTitle}>{dict.match.label}</h3>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            checked={values.exactMatch}
            onChange={(event) => onChange({ exactMatch: event.target.checked })}
          />
          <span>
            {dict.filters.exactMatchOnly}
            <span className={styles.note}>{dict.filters.exactMatchNote}</span>
          </span>
        </label>
      </section>

      {couponFilterUseful ? (
        <section className={styles.group}>
          <h3 className={styles.groupTitle}>{dict.nav.coupons}</h3>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={values.withCoupon}
              onChange={(event) => onChange({ withCoupon: event.target.checked })}
            />
            <span>{dict.filters.withCoupon}</span>
          </label>
        </section>
      ) : null}

      {hasActiveFilters(values) ? (
        <Button variant="ghost" size="sm" onClick={onClear} block>
          {dict.search.clearFilters}
        </Button>
      ) : null}
    </div>
  );
}

export function SortSelect({
  value,
  onChange,
  className,
}: {
  readonly value: string;
  readonly onChange: (sort: string) => void;
  readonly className?: string;
}) {
  const { dict } = useLocale();

  return (
    <label>
      <span className="visually-hidden">{dict.search.sortLabel}</span>
      <select
        className={className}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {dict.sort[option]}
          </option>
        ))}
      </select>
    </label>
  );
}
