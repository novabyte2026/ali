'use client';

import type { ReactNode } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import styles from './Prose.module.css';

/**
 * Shell for the legal pages.
 *
 * These pages ship as drafts and say so. Writing finished terms and a finished
 * privacy policy is a legal task that depends on the operating entity, the
 * jurisdiction and the final data practices — none of which a codebase can
 * decide. What this provides is the accurate technical description of what the
 * system actually does, which is the part the lawyer needs and the part that
 * would otherwise be guessed at.
 */
export function LegalPage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const { locale } = useLocale();

  return (
    <div className="page-narrow">
      <PageHeader title={title} />
      <div className={styles.prose}>
        <div className={styles.featureItem}>
          <p className={styles.featureBlocked}>
            {locale === 'he'
              ? 'הטקסט הזה הוא טיוטה שמתארת את ההתנהגות הטכנית של המערכת. הוא אינו ייעוץ משפטי וטעון בדיקה משפטית לפני עלייה לאוויר.'
              : 'This text is a draft describing the system’s technical behaviour. It is not legal advice and needs legal review before going live.'}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
