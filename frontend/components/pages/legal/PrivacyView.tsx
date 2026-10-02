'use client';

import { useLocale } from '@/components/LocaleProvider';
import { LegalPage } from '../LegalPage';
import styles from '../Prose.module.css';

/**
 * Privacy policy.
 *
 * Describes what the system actually does, which is unusually easy to state
 * here because the data model was built around minimisation: search history is
 * off by default, analytics is off by default, affiliate attribution is keyed
 * on a rotating session hash rather than an account, and the three live in
 * separate tables with separate retention.
 */
export function PrivacyView() {
  const { dict, locale } = useLocale();
  const he = locale === 'he';

  return (
    <LegalPage title={dict.legal.privacy}>
      <h2>{he ? 'מה אנחנו אוספים' : 'What we collect'}</h2>
      <ul className={styles.bullets}>
        <li>
          {he
            ? 'כשאתה מחפש כאורח, אנחנו לא שומרים את החיפוש שלך. אנחנו שומרים מדדי תפעול — כמה זמן לקח, אילו חנויות השיבו — בלי מזהה אישי.'
            : 'When you search as a guest we do not store your query. We store operational metrics — how long it took, which stores answered — with no personal identifier.'}
        </li>
        <li>
          {he
            ? 'היסטוריית חיפושים נשמרת רק אם הדלקת אותה בהגדרות. כברירת מחדל היא כבויה, וכיבוי שלה מוחק את מה שכבר נשמר.'
            : 'Search history is stored only if you turn it on. It is off by default, and turning it off deletes what was already stored.'}
        </li>
        <li>
          {he
            ? 'כשאתה מתחבר עם Google אנחנו שומרים את כתובת המייל, השם ותמונת הפרופיל אם סופקה, ומזהה יציב מ-Google. אנחנו לא מקבלים את הסיסמה שלך.'
            : 'When you sign in with Google we store your e-mail address, your name, your profile picture if supplied, and a stable identifier from Google. We never receive your password.'}
        </li>
        <li>
          {he
            ? 'לחיצה על קישור לחנות נרשמת עם מזהה סשן מתחלף, לא עם זהות החשבון, אלא אם אתה מחובר. הרישום הזה משמש להתחשבנות עמלות מול החנות.'
            : 'A click through to a store is recorded against a rotating session identifier rather than your account identity, unless you are signed in. That record exists to reconcile commission with the store.'}
        </li>
        <li>
          {he
            ? 'אנחנו לא שומרים כתובות IP או מחרוזות דפדפן בטקסט גלוי. היכן שאנחנו צריכים לזהות סשן חוזר, אנחנו שומרים גיבוב מלוח.'
            : 'We do not store IP addresses or browser strings in the clear. Where we need to recognise a returning session we store a salted hash.'}
        </li>
      </ul>

      <h2>{he ? 'מה אנחנו לא עושים' : 'What we do not do'}</h2>
      <ul className={styles.bullets}>
        <li>
          {he
            ? 'אנחנו לא מוכרים מידע אישי ולא משתפים אותו עם מפרסמים.'
            : 'We do not sell personal data and we do not share it with advertisers.'}
        </li>
        <li>
          {he
            ? 'אנחנו לא בונים פרופיל התנהגותי כתוצר לוואי. נתוני שימוש נאספים רק אם הסכמת להם במפורש.'
            : 'We do not build a behavioural profile as a side effect. Usage analytics are collected only with your explicit consent.'}
        </li>
        <li>
          {he
            ? 'אנחנו לא משתמשים בתוכן של החנויות לאימון מודלים.'
            : 'We do not use store content to train models.'}
        </li>
      </ul>

      <h2>{he ? 'שליטה' : 'Your controls'}</h2>
      <ul className={styles.bullets}>
        <li>
          {he
            ? 'אפשר להוריד את כל מה ששמור על החשבון כקובץ JSON מעמוד החשבון.'
            : 'You can download everything held on your account as a JSON file from the account page.'}
        </li>
        <li>
          {he
            ? 'אפשר למחוק את החשבון. המחיקה מוחקת את השמורים, החיפושים, ההתראות והסלים, ומנתקת את רישומי הקליקים מהזהות שלך.'
            : 'You can delete your account. Deletion removes your saved items, searches, alerts and baskets, and detaches click records from your identity.'}
        </li>
        <li>
          {he
            ? 'כל הגדרת פרטיות ניתנת לשינוי בכל רגע, וכל שינוי נרשם ביומן הסכמות.'
            : 'Every privacy setting can be changed at any time, and each change is written to a consent ledger.'}
        </li>
      </ul>

      <h2>{he ? 'שמירה' : 'Retention'}</h2>
      <p>
        {he
          ? 'מדדי תפעול נשמרים 30 ימים. נתוני שימוש, אם אישרת אותם, נשמרים 90 ימים. היסטוריית חיפושים, אם הדלקת אותה, נשמרת 180 ימים. נתונים שמגיעים מחנות נשמרים רק למשך שמותר לפי תנאי אותה חנות, ולעיתים כלל לא מעבר לבקשה עצמה.'
          : 'Operational metrics are kept for 30 days. Usage analytics, if you consented, for 90 days. Search history, if you enabled it, for 180 days. Data that comes from a store is kept only as long as that store’s terms permit, and in some cases not beyond the request itself.'}
      </p>
    </LegalPage>
  );
}
