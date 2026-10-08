'use client';

import Link from 'next/link';
import { useLocale } from '@/components/LocaleProvider';
import styles from './Footer.module.css';

/**
 * Footer.
 *
 * Carries the site-wide affiliate disclosure in ordinary body text on every
 * page. Not in small print, not behind a link, not only on a legal page
 * (rules 22, 43) — a disclosure that has to be hunted for is not a disclosure.
 *
 * The per-programme notices come from the policy registry, so when a programme
 * requires specific wording, that wording appears rather than a generic
 * sentence covering all three (rule 43).
 */

export function Footer({
  programmes,
}: {
  readonly programmes: ReadonlyArray<{
    readonly providerId: string;
    readonly programmeName: string;
    readonly displayName: string;
  }>;
}) {
  const { dict } = useLocale();
  const year = new Date().getFullYear();

  return (
    <footer className={styles.footer}>
      <div className="page">
        <div className={styles.columns}>
          <div className={styles.brandColumn}>
            <div className={styles.brand}>{dict.brand.name}</div>
            <p className={styles.tagline}>{dict.affiliate.transparency.summary}</p>
          </div>

          <div>
            <h2 className={styles.columnTitle}>{dict.footer.product}</h2>
            <ul className={styles.linkList}>
              <li>
                <Link href="/search" className={styles.link}>
                  {dict.nav.search}
                </Link>
              </li>
              <li>
                <Link href="/coupons" className={styles.link}>
                  {dict.nav.coupons}
                </Link>
              </li>
              <li>
                <Link href="/deals" className={styles.link}>
                  {dict.nav.deals}
                </Link>
              </li>
              <li>
                <Link href="/check" className={styles.link}>
                  {dict.nav.check}
                </Link>
              </li>
              <li>
                <Link href="/how-it-works" className={styles.link}>
                  {dict.nav.howItWorks}
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className={styles.columnTitle}>{dict.footer.legalSection}</h2>
            <ul className={styles.linkList}>
              <li>
                <Link href="/legal/affiliate-disclosure" className={styles.link}>
                  {dict.legal.affiliateDisclosure}
                </Link>
              </li>
              <li>
                <Link href="/legal/privacy" className={styles.link}>
                  {dict.legal.privacy}
                </Link>
              </li>
              <li>
                <Link href="/legal/terms" className={styles.link}>
                  {dict.legal.terms}
                </Link>
              </li>
              <li>
                <Link href="/legal/cookies" className={styles.link}>
                  {dict.legal.cookies}
                </Link>
              </li>
              <li>
                <Link href="/legal/about" className={styles.link}>
                  {dict.legal.about}
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h2 className={styles.columnTitle}>{dict.footer.sourcesSection}</h2>
            <ul className={styles.linkList}>
              {programmes.map((programme) => (
                <li key={programme.providerId} className={styles.programme}>
                  {programme.displayName}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className={styles.disclosure}>
          <p className={styles.disclosureText}>{dict.footer.disclosure}</p>
          <Link href="/legal/affiliate-disclosure" className={styles.disclosureLink}>
            {dict.affiliate.howWeEarn}
          </Link>
        </div>

        <div className={styles.bottom}>
          <span>{dict.footer.copyright(year)}</span>
          {programmes.length > 0 ? (
            <div className={styles.programmes}>
              {programmes.map((programme) => (
                <span key={programme.providerId} className={styles.programme}>
                  {programme.programmeName}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
