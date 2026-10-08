'use client';

import { useEffect, useState } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { apiRequest } from '@/lib/api';
import styles from './Prose.module.css';

/**
 * Affiliate disclosure page.
 *
 * The per-programme notices are rendered from the policy registry rather than
 * written here, so each programme's required wording appears verbatim and a
 * change to a programme's terms is an operator edit, not a code change
 * (rules 43, 116, 299). Writing one sentence that covers all three programmes
 * would be convenient and would not satisfy any of them.
 */

interface TransparencyResponse {
  readonly locale: string;
  readonly summaryKey: string;
  readonly pointKeys: ReadonlyArray<string>;
  readonly programmes: ReadonlyArray<{
    readonly providerId: string;
    readonly programmeName: string;
    readonly termsUrl: string | null;
    readonly disclosure: string | null;
  }>;
}

export function AffiliateDisclosureView() {
  const { dict } = useLocale();
  const [data, setData] = useState<TransparencyResponse | null>(null);

  useEffect(() => {
    void apiRequest<TransparencyResponse>('/api/v1/affiliate/transparency')
      .then(setData)
      .catch(() => setData(null));
  }, []);

  return (
    <div className="page-narrow">
      <PageHeader title={dict.legal.affiliateDisclosure} />

      <div className={styles.prose}>
        <p>{dict.affiliate.transparency.summary}</p>

        <h2>{dict.affiliate.howWeEarn}</h2>
        <ul className={styles.bullets}>
          <li>{dict.affiliate.transparency.commission}</li>
          <li>{dict.affiliate.transparency.priceUnaffected}</li>
          <li>{dict.affiliate.transparency.rankingNotPaid}</li>
          <li>{dict.affiliate.transparency.dataFromThirdParties}</li>
          <li>{dict.affiliate.transparency.priceSetByStore}</li>
        </ul>

        {data && data.programmes.length > 0 ? (
          <>
            <h2>{dict.affiliate.programmes}</h2>
            {data.programmes.map((programme) => (
              <section key={programme.providerId} className={styles.featureItem}>
                <h3>{programme.programmeName}</h3>
                {/* The programme's own required wording, as recorded in the
                 * policy registry. */}
                {programme.disclosure ? <p>{programme.disclosure}</p> : null}
                {programme.termsUrl ? (
                  <p>
                    <a href={programme.termsUrl} rel="noopener noreferrer nofollow" target="_blank">
                      {programme.termsUrl}
                    </a>
                  </p>
                ) : null}
              </section>
            ))}
          </>
        ) : null}

        <h2>{dict.home.trustHeading}</h2>
        <ul className={styles.bullets}>
          <li>{dict.home.trustPoints.ranking}</li>
          <li>{dict.home.trustPoints.provenance}</li>
          <li>{dict.home.trustPoints.unknown}</li>
          <li>{dict.home.trustPoints.identity}</li>
        </ul>
      </div>
    </div>
  );
}
