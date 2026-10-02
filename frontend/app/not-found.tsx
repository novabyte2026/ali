import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { dictionary, isLocale, negotiateLocale } from '@/lib/i18n';
import styles from './not-found.module.css';

/**
 * Not-found page.
 *
 * A server component so it renders in the right language without client
 * JavaScript, and offers a way forward rather than being a dead end (rule 174).
 */
export default async function NotFound() {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const fromCookie = cookieStore.get('shelf_locale')?.value;
  const locale = isLocale(fromCookie)
    ? fromCookie
    : negotiateLocale(headerStore.get('accept-language'));
  const dict = dictionary(locale);

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>{dict.errors.ERROR_NOT_FOUND}</h1>
      <div className={styles.actions}>
        <Link href="/" className={styles.primary}>
          {dict.errors.backHome}
        </Link>
        <Link href="/search" className={styles.secondary}>
          {dict.nav.search}
        </Link>
      </div>
    </div>
  );
}
