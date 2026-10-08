'use client';

import { useLocale } from '@/components/LocaleProvider';
import { LegalPage } from '../LegalPage';
import styles from '../Prose.module.css';

export function TermsView() {
  const { dict, locale } = useLocale();
  const he = locale === 'he';

  return (
    <LegalPage title={dict.legal.terms}>
      <h2>{he ? 'מה השירות הזה' : 'What this service is'}</h2>
      <p>
        {he
          ? 'Shelf הוא מנוע חיפוש והשוואה. אנחנו לא מוכרים מוצרים, לא מחזיקים מלאי, לא מטפלים בתשלומים ולא אחראים למשלוח. כל רכישה מתבצעת מול החנות עצמה ובכפוף לתנאים שלה.'
          : 'Shelf is a search and comparison engine. We do not sell products, hold stock, handle payments or fulfil shipments. Every purchase happens with the store itself and under that store’s terms.'}
      </p>

      <h2>{he ? 'על המידע שמוצג' : 'About the information shown'}</h2>
      <ul className={styles.bullets}>
        <li>
          {he
            ? 'מחירים, זמינות ופרטי מוצר מגיעים מהחנויות דרך הממשקים שהן מאפשרות, ומוצגים עם מועד הבדיקה שלהם.'
            : 'Prices, availability and product details come from the stores through the interfaces they provide, and are shown with the time they were observed.'}
        </li>
        <li>
          {he
            ? 'המחיר והזמינות הקובעים הם אלה שמופיעים באתר החנות בזמן הרכישה.'
            : 'The price and availability that count are those shown on the store’s own site at the time of purchase.'}
        </li>
        <li>
          {he
            ? 'כשנתון אינו ידוע לנו, כתוב שהוא אינו ידוע. אנחנו לא משלימים נתונים חסרים בהערכה שאינה מסומנת ככזו.'
            : 'Where a value is not known to us, we say so. We do not fill a gap with an estimate that is not labelled as one.'}
        </li>
        <li>
          {he
            ? 'קביעה ש"זה אותו דגם" נעשית רק על בסיס מזהה יצרן. במקרים אחרים כתוב "מוצר דומה".'
            : 'A claim that two listings are the same model rests on a manufacturer identifier. Otherwise we say "similar product".'}
        </li>
      </ul>

      <h2>{he ? 'קישורי שותפים' : 'Affiliate links'}</h2>
      <p>
        {he
          ? 'חלק מהקישורים הם קישורי שותפים, ואנחנו עשויים לקבל עמלה מהחנות אם תרכוש דרכם. העמלה משולמת על ידי החנות ולא על ידך, והיא אינה גורם בדירוג התוצאות.'
          : 'Some links are affiliate links and we may earn a commission from the store if you buy through them. The commission is paid by the store and not by you, and it is not a factor in how results are ranked.'}
      </p>

      <h2>{he ? 'שימוש מקובל' : 'Acceptable use'}</h2>
      <ul className={styles.bullets}>
        <li>
          {he
            ? 'אין לגרד את השירות באופן אוטומטי או לעקוף את מגבלות הקצב שלו.'
            : 'Do not scrape the service or circumvent its rate limits.'}
        </li>
        <li>
          {he
            ? 'אין להציג מחדש את התוכן של החנויות דרכנו באופן שאינו מותר על ידן.'
            : 'Do not re-publish store content obtained through us in ways those stores do not permit.'}
        </li>
      </ul>
    </LegalPage>
  );
}
