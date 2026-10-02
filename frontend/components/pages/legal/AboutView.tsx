'use client';

import Link from 'next/link';
import { useLocale } from '@/components/LocaleProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import styles from '../Prose.module.css';

/**
 * About.
 *
 * States the product's position plainly, including the uncomfortable part:
 * this is an affiliate business, and the thing that makes it worth using is
 * that the ranking is not for sale and the data is not embellished.
 */
export function AboutView() {
  const { dict, locale } = useLocale();
  const he = locale === 'he';

  return (
    <div className="page-narrow">
      <PageHeader title={dict.legal.about} />

      <div className={styles.prose}>
        <p>
          {he
            ? 'Shelf הוא מנוע חיפוש והשוואה בין חנויות. הוא מקבל חיפוש בשפה רגילה, שולח אותו לחנויות שאנחנו מחוברים אליהן, מזהה מתי אותו מוצר מופיע ביותר ממקום אחד, ומראה מה זה עולה בפועל.'
            : 'Shelf is a search and comparison engine across stores. It takes a search in ordinary words, sends it to the stores we are connected to, works out when the same product appears in more than one of them, and shows what it actually costs.'}
        </p>

        <h2>{he ? 'איך אנחנו מתפרנסים' : 'How we are funded'}</h2>
        <p>
          {he
            ? 'זהו עסק של שיווק שותפים. כשאתה עובר לחנות דרך קישור שלנו ורוכש, אנחנו עשויים לקבל עמלה. זה מודל שיוצר לחץ מובנה להטות תוצאות, ולכן בנינו את המערכת כך שגובה העמלה פשוט לא מגיע לשלב הדירוג — אין קוד שקורא אותו שם.'
            : 'This is an affiliate business. When you go to a store through our link and buy, we may earn a commission. That model creates a built-in pressure to skew results, which is why the system is built so that commission never reaches the ranking stage at all — no code there reads it.'}
        </p>

        <h2>{he ? 'מה אנחנו לא עושים' : 'What we do not do'}</h2>
        <ul className={styles.bullets}>
          <li>
            {he
              ? 'לא ממציאים נתון חסר. אם מחיר משלוח לא ידוע, כתוב שהוא לא ידוע.'
              : 'We do not invent a missing figure. If a shipping cost is unknown, we say it is unknown.'}
          </li>
          <li>
            {he
              ? 'לא קובעים שזה "אותו מוצר" בלי מזהה יצרן תואם.'
              : 'We do not claim two listings are the same product without a matching manufacturer identifier.'}
          </li>
          <li>
            {he
              ? 'לא יוצרים דחיפות מלאכותית. אין טיימרים, אין "נשארו 2".'
              : 'We do not manufacture urgency. No timers, no "only 2 left".'}
          </li>
          <li>
            {he
              ? 'לא מציגים קופון כמאומת אם לא בדקנו אותו.'
              : 'We do not present a coupon as verified unless we checked it.'}
          </li>
        </ul>

        <p>
          <Link href="/how-it-works">{dict.nav.howItWorks}</Link>
          {' · '}
          <Link href="/legal/affiliate-disclosure">{dict.legal.affiliateDisclosure}</Link>
        </p>
      </div>
    </div>
  );
}
