'use client';

import { useLocale } from '@/components/LocaleProvider';
import { InfoIcon } from '@/components/ui/Icon';
import styles from './DemoBanner.module.css';

/**
 * Demo-data banner.
 *
 * Shown on every page whenever any provider is serving fixtures. Deliberately
 * not dismissible: the whole point of the fixture mechanism is that sample
 * data cannot be mistaken for real offers, and a banner a user can close
 * defeats that on the second page view.
 *
 * It is also not an error. Development and review are legitimate states, so
 * the tone is informational rather than alarming.
 */
export function DemoBanner({ providerIds }: { readonly providerIds: ReadonlyArray<string> }) {
  const { dict } = useLocale();
  if (providerIds.length === 0) return null;

  return (
    <div className={styles.banner} role="status">
      <div className="page">
        <div className={styles.inner}>
          <InfoIcon />
          <p className={styles.text}>{dict.demo.banner}</p>
          <span className={styles.sources}>{providerIds.join(', ')}</span>
        </div>
      </div>
    </div>
  );
}
