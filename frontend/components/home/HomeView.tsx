'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SOURCE_MODES, type SourceMode } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { SearchBox } from '@/components/search/SearchBox';
import { Badge } from '@/components/ui/Badge';
import { ArrowRightIcon, ShieldIcon } from '@/components/ui/Icon';
import { fetchSearchExamples, type SearchExample } from '@/lib/api';
import { useReveal } from '@/lib/hooks';
import styles from '@/app/page.module.css';

/**
 * Home view.
 *
 * The brief for this screen was "simple, not a wall of information". So: one
 * question, one field, four routes, and then the three things a sceptical
 * first-time visitor needs — how it works, what we will and will not claim,
 * and how we make money.
 *
 * The four source cards show each route's real state. A route that cannot
 * answer right now is still shown and still clickable, carrying the reason,
 * because the four routes are the structure of the product and removing one
 * would be more confusing than labelling it.
 */

export function HomeView() {
  const { dict, locale, countryCode, currency } = useLocale();
  const router = useRouter();
  const [examples, setExamples] = useState<ReadonlyArray<SearchExample>>([]);

  useEffect(() => {
    void fetchSearchExamples(locale)
      .then((response) => setExamples(response.examples))
      .catch(() => setExamples([]));
  }, [locale]);

  const submit = (query: string, mode: SourceMode = 'all'): void => {
    const params = new URLSearchParams({
      q: query,
      source: mode,
      country: countryCode,
      currency,
    });
    router.push(`/search?${params.toString()}`);
  };

  return (
    <>
      <section className={styles.hero}>
        <div className="page">
          <div className={styles.heroInner}>
            <h1 className={styles.heading}>{dict.home.heading}</h1>
            <p className={styles.subheading}>{dict.home.subheading}</p>

            <div className={styles.searchWrap}>
              <SearchBox variant="hero" autoFocus onSubmit={(query) => submit(query)} />

              {examples.length > 0 ? (
                <div className={styles.examples}>
                  <span className={styles.examplesLabel}>{dict.home.popularSearches}</span>
                  {examples.map((example) => (
                    <button
                      key={example.query}
                      type="button"
                      className={styles.example}
                      onClick={() => submit(example.query)}
                    >
                      {example.text}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <SourceCards onSelect={submit} />

      <HowItWorks />

      <TrustSection />
    </>
  );
}

function SourceCards({
  onSelect,
}: {
  readonly onSelect: (query: string, mode: SourceMode) => void;
}) {
  const { dict, countryCode, currency } = useLocale();
  const providers = useProviders();
  const { ref, visible } = useReveal<HTMLElement>();

  const searchable = providers.searchableProviderIds();

  return (
    <section ref={ref} className={`${styles.section} reveal`} data-visible={visible}>
      <div className="page">
        <h2 className={styles.sectionHeading}>{dict.home.chooseSource}</h2>

        <div className={styles.sourceGrid}>
          {SOURCE_MODES.map((mode) => {
            const available =
              mode === 'all' ? searchable.length > 0 : searchable.includes(mode);

            const searchState =
              mode === 'all' ? null : providers.capability(mode, 'search');

            const stateNote = available
              ? null
              : searchState === 'VERIFICATION_REQUIRED'
                ? dict.sources.pendingVerification
                : searchState === 'NOT_CONFIGURED'
                  ? dict.sources.notConfigured
                  : dict.sources.unavailable;

            // Capabilities worth naming on the card, so the differences
            // between routes are visible before a user commits to one.
            const capabilities =
              mode === 'all'
                ? []
                : (['coupons', 'deals', 'priceHistory'] as const).filter(
                    (capability) => providers.can(mode, capability),
                  );

            const href = `/search?${new URLSearchParams({
              q: '',
              source: mode,
              country: countryCode,
              currency,
            }).toString()}`;

            return (
              <Link
                key={mode}
                href={href}
                className={[
                  styles.sourceCard,
                  mode === 'all' ? styles.sourceCardPrimary : '',
                  available ? '' : styles.sourceCardUnavailable,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className={styles.sourceName}>{dict.sources[mode]}</span>
                <span className={styles.sourceDescription}>
                  {mode === 'all'
                    ? dict.sources.allDescription
                    : dict.sources[`${mode}Description` as 'amazonDescription']}
                </span>

                <span className={styles.sourceFooter}>
                  {stateNote ? (
                    <Badge tone="unknown">{stateNote}</Badge>
                  ) : (
                    <>
                      {capabilities.length > 0 ? (
                        <span className={styles.sourceCapabilities}>
                          {capabilities.map((capability) => (
                            <Badge key={capability} tone="neutral">
                              {capability === 'coupons'
                                ? dict.nav.coupons
                                : capability === 'deals'
                                  ? dict.nav.deals
                                  : dict.capability.priceHistoryUnavailable}
                            </Badge>
                          ))}
                        </span>
                      ) : null}
                      <span className={styles.sourceCta}>
                        {dict.home.searchButton}
                        <ArrowRightIcon />
                      </span>
                    </>
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const { dict } = useLocale();
  const { ref, visible } = useReveal<HTMLElement>();

  const steps = [
    dict.home.steps.describe,
    dict.home.steps.search,
    dict.home.steps.compare,
    dict.home.steps.decide,
  ];

  return (
    <section ref={ref} className={`${styles.section} reveal`} data-visible={visible}>
      <div className="page">
        <h2 className={styles.sectionHeading}>{dict.home.howItWorksHeading}</h2>

        <div className={styles.steps}>
          {steps.map((step, index) => (
            <div key={step.title} className={styles.step}>
              <span className={styles.stepNumber}>{index + 1}</span>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepBody}>{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * "What we show, and what we do not."
 *
 * This section exists because the product's main differentiator is what it
 * refuses to claim, and that is invisible until someone has used it enough to
 * notice. Stating it up front is the honest version of a feature list.
 */
function TrustSection() {
  const { dict } = useLocale();
  const { ref, visible } = useReveal<HTMLElement>();

  const points = [
    dict.home.trustPoints.provenance,
    dict.home.trustPoints.unknown,
    dict.home.trustPoints.identity,
    dict.home.trustPoints.ranking,
  ];

  return (
    <section ref={ref} className={`${styles.trustSection} reveal`} data-visible={visible}>
      <div className="page">
        <h2 className={styles.sectionHeading}>{dict.home.trustHeading}</h2>

        <div className={styles.trustGrid}>
          {points.map((point) => (
            <div key={point} className={styles.trustItem}>
              <ShieldIcon className={styles.trustIcon} size={18} />
              <p className={styles.trustText}>{point}</p>
            </div>
          ))}
        </div>

        <div className={styles.transparency} style={{ marginTop: 'var(--s-8)' }}>
          <h3 className={styles.transparencyHeading}>{dict.affiliate.howWeEarn}</h3>
          <p className={styles.transparencyText}>{dict.affiliate.transparency.summary}</p>
          <p className={styles.transparencyText}>{dict.affiliate.transparency.rankingNotPaid}</p>
          <Link href="/legal/affiliate-disclosure" className={styles.transparencyLink}>
            {dict.legal.affiliateDisclosure}
          </Link>
        </div>
      </div>
    </section>
  );
}
