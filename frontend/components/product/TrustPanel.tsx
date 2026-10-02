'use client';

import { useLocale } from '@/components/LocaleProvider';
import { Badge } from '@/components/ui/Badge';
import { InfoIcon } from '@/components/ui/Icon';
import { relativeTime } from '@/lib/datum';
import styles from './TrustPanel.module.css';

/**
 * Trust panel.
 *
 * Answers, for one product page: where did this come from, when was it
 * checked, what is missing, and what this source does not provide at all
 * (rules 44, 156).
 *
 * The last of those is the part that is usually hidden. A product page with no
 * star rating looks like a product nobody has reviewed; saying "this source
 * does not provide ratings through our integration" is a different and true
 * statement, and it stops a user drawing the wrong conclusion about the
 * product from a gap in our data.
 */
export function TrustPanel({
  providerName,
  observedAt,
  policyVersion,
  missingComponents,
  restrictedFields,
  containsDemoData,
}: {
  readonly providerName: string;
  readonly observedAt: string | null;
  readonly policyVersion: string;
  readonly missingComponents: ReadonlyArray<string>;
  readonly restrictedFields: ReadonlyArray<string>;
  readonly containsDemoData: boolean;
}) {
  const { dict } = useLocale();

  const missingLabels = missingComponents
    .map((component) => dict.price.missing[component as keyof typeof dict.price.missing])
    .filter(Boolean);

  const restrictedLabels = restrictedFields
    .map((field) => dict.trust.fields[field as keyof typeof dict.trust.fields])
    .filter(Boolean);

  return (
    <section className={styles.panel} aria-labelledby="trust-heading">
      <h2 id="trust-heading" className={styles.heading}>
        <InfoIcon size={16} />
        {dict.trust.heading}
      </h2>

      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt className={styles.label}>{dict.trust.source}</dt>
          <dd className={styles.value}>{providerName}</dd>
        </div>

        {observedAt ? (
          <div className={styles.row}>
            <dt className={styles.label}>{dict.trust.observedAt}</dt>
            <dd className={styles.value}>{relativeTime(observedAt, dict)}</dd>
          </div>
        ) : null}

        <div className={styles.row}>
          <dt className={styles.label}>{dict.trust.policyVersion}</dt>
          <dd className={styles.valueMono}>{policyVersion}</dd>
        </div>
      </dl>

      {missingLabels.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{dict.trust.whatsMissing}</h3>
          <ul className={styles.list}>
            {missingLabels.map((label) => (
              <li key={label} className={styles.listItem}>
                {label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {restrictedLabels.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupTitle}>{dict.trust.restrictedFields}</h3>
          <ul className={styles.list}>
            {restrictedLabels.map((label) => (
              <li key={label} className={styles.listItem}>
                {label}
              </li>
            ))}
          </ul>
          <p className={styles.groupNote}>{dict.capability.reasons.NOT_PERMITTED}</p>
        </div>
      ) : null}

      {containsDemoData ? (
        <div className={styles.demo}>
          <Badge tone="estimated" icon>
            {dict.trust.demoData}
          </Badge>
          <span className={styles.demoText}>{dict.demo.banner}</span>
        </div>
      ) : null}
    </section>
  );
}
