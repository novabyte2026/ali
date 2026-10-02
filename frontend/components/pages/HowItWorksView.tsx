'use client';

import { useEffect, useState } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { apiRequest } from '@/lib/api';
import styles from './Prose.module.css';

/**
 * How it works.
 *
 * Explains the mechanism rather than selling it, and then shows the feature
 * register straight from the API — including the features that are partial or
 * planned. Publishing that is unusual, and it is the point: a product whose
 * main claim is honesty about data should be honest about itself (rule 253).
 */

interface FeatureStatusResponse {
  readonly features: ReadonlyArray<{
    readonly id: string;
    readonly area: string;
    readonly status: 'PRODUCTION_READY' | 'PARTIAL' | 'INTEGRATION_PENDING' | 'PLANNED';
    readonly note: string;
    readonly blockedBy?: string;
  }>;
  readonly counts: Record<string, number>;
}

export function HowItWorksView() {
  const { dict } = useLocale();
  const providers = useProviders();
  const [features, setFeatures] = useState<FeatureStatusResponse | null>(null);

  useEffect(() => {
    void apiRequest<FeatureStatusResponse>('/api/v1/meta/features')
      .then(setFeatures)
      .catch(() => setFeatures(null));
  }, []);

  const steps = [
    dict.home.steps.describe,
    dict.home.steps.search,
    dict.home.steps.compare,
    dict.home.steps.decide,
  ];

  return (
    <div className="page-narrow">
      <PageHeader title={dict.home.howItWorksHeading} lead={dict.home.subheading} />

      <div className={styles.prose}>
        <ol className={styles.steps}>
          {steps.map((step, index) => (
            <li key={step.title} className={styles.step}>
              <span className={styles.stepNumber}>{index + 1}</span>
              <div>
                <h2 className={styles.stepTitle}>{step.title}</h2>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <h2>{dict.home.trustHeading}</h2>
        <ul className={styles.bullets}>
          <li>{dict.home.trustPoints.provenance}</li>
          <li>{dict.home.trustPoints.unknown}</li>
          <li>{dict.home.trustPoints.identity}</li>
          <li>{dict.home.trustPoints.ranking}</li>
        </ul>

        <h2>{dict.affiliate.howWeEarn}</h2>
        <p>{dict.affiliate.transparency.summary}</p>
        <ul className={styles.bullets}>
          <li>{dict.affiliate.transparency.commission}</li>
          <li>{dict.affiliate.transparency.priceUnaffected}</li>
          <li>{dict.affiliate.transparency.rankingNotPaid}</li>
          <li>{dict.affiliate.transparency.dataFromThirdParties}</li>
          <li>{dict.affiliate.transparency.priceSetByStore}</li>
        </ul>

        <h2>{dict.home.chooseSource}</h2>
        <ul className={styles.sourceList}>
          {(providers.data?.providers ?? []).map((provider) => (
            <li key={provider.id} className={styles.sourceItem}>
              <span className={styles.sourceName}>{provider.branding.displayName}</span>
              <Badge
                tone={provider.capabilities.search === 'AVAILABLE' ? 'known' : 'unknown'}
              >
                {provider.capabilities.search === 'AVAILABLE'
                  ? dict.search.attemptStatus.OK
                  : dict.sources.pendingVerification}
              </Badge>
            </li>
          ))}
        </ul>

        {features ? (
          <>
            <h2>{dict.admin.features}</h2>
            <ul className={styles.featureList}>
              {features.features.map((feature) => (
                <li key={feature.id} className={styles.featureItem}>
                  <div className={styles.featureTop}>
                    <code className={styles.featureId}>{feature.id}</code>
                    <Badge tone={toneFor(feature.status)}>
                      {dict.admin.featureStatus[feature.status]}
                    </Badge>
                  </div>
                  <p className={styles.featureNote}>{feature.note}</p>
                  {feature.blockedBy ? (
                    <p className={styles.featureBlocked}>{feature.blockedBy}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}

function toneFor(status: string): 'known' | 'estimated' | 'unknown' {
  if (status === 'PRODUCTION_READY') return 'known';
  if (status === 'PARTIAL' || status === 'INTEGRATION_PENDING') return 'estimated';
  return 'unknown';
}
