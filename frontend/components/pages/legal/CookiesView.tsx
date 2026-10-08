'use client';

import { useLocale } from '@/components/LocaleProvider';
import { LegalPage } from '../LegalPage';
import styles from '../Prose.module.css';

/**
 * Cookie policy.
 *
 * Short, because the cookie set is short. There is no consent banner in this
 * product, and the reason is not an oversight: it sets no advertising or
 * cross-site tracking cookies at all, so there is nothing to ask consent for
 * beyond the strictly necessary ones (rule 167). Usage analytics is a server-
 * side, consent-gated account setting rather than a cookie.
 */
export function CookiesView() {
  const { dict, locale } = useLocale();
  const he = locale === 'he';

  return (
    <LegalPage title={dict.legal.cookies}>
      <p>
        {he
          ? 'האתר הזה לא משתמש בקובצי Cookie לפרסום, לא בפיקסלים של רשתות חברתיות ולא במעקב חוצה-אתרים. לכן גם אין כאן באנר הסכמה — אין למה להסכים מעבר לקבצים ההכרחיים.'
          : 'This site uses no advertising cookies, no social pixels and no cross-site tracking. That is also why there is no consent banner here — there is nothing to consent to beyond the strictly necessary files.'}
      </p>

      <h2>{he ? 'מה כן נשמר' : 'What is stored'}</h2>
      <ul className={styles.bullets}>
        <li>
          <strong>shelf_session</strong>
          {' — '}
          {he
            ? 'קובץ הסשן, נוצר רק אחרי התחברות. httpOnly, כך שקוד JavaScript באתר אינו יכול לקרוא אותו. בלעדיו אי אפשר להישאר מחובר.'
            : 'the session cookie, created only after you sign in. httpOnly, so JavaScript on the page cannot read it. Without it you cannot stay signed in.'}
        </li>
        <li>
          <strong>shelf_locale</strong>, <strong>shelf_country</strong>,{' '}
          <strong>shelf_currency</strong>
          {' — '}
          {he
            ? 'העדפות התצוגה שלך, כדי שהעמוד ייטען בשפה ובמטבע הנכונים כבר בטעינה הראשונה.'
            : 'your display preferences, so the page loads in the right language and currency on first paint.'}
        </li>
      </ul>

      <h2>{he ? 'אחסון מקומי' : 'Local storage'}</h2>
      <p>
        {he
          ? 'איננו משתמשים ב-localStorage לאחסון מידע אישי. כל מה שנשמר על החשבון שלך נשמר בשרת, שם אפשר להוריד אותו או למחוק אותו.'
          : 'We do not use localStorage to hold personal data. Anything saved to your account lives on the server, where you can export it or delete it.'}
      </p>
    </LegalPage>
  );
}
