'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { Button } from '@/components/ui/Button';
import { BookmarkIcon, MenuIcon, CloseIcon, UserIcon } from '@/components/ui/Icon';
import styles from './Header.module.css';

/**
 * Header.
 *
 * Desktop: brand, a compact search field on pages other than the home page,
 * the primary links and the account control. Mobile: brand, search, and a
 * disclosure menu — not nine icons in a bottom bar.
 *
 * The bar stays put while scrolling rather than shrinking or hiding. A header
 * that animates away takes the navigation with it, and this product is one
 * people navigate between results, comparisons and stores.
 */

export function Header({
  searchSlot,
  tabSlot,
  authenticated,
  isAdmin,
}: {
  readonly searchSlot?: ReactNode;
  readonly tabSlot?: ReactNode;
  readonly authenticated: boolean;
  readonly isAdmin: boolean;
}) {
  const { dict } = useLocale();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Close the mobile menu on navigation, so a link tap does not leave it open
  // over the page it just loaded.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const isHome = pathname === '/';

  const links: ReadonlyArray<{ href: string; label: string }> = [
    { href: '/coupons', label: dict.nav.coupons },
    { href: '/deals', label: dict.nav.deals },
    { href: '/check', label: dict.nav.check },
    { href: '/how-it-works', label: dict.nav.howItWorks },
  ];

  return (
    <header className={`${styles.header} ${scrolled ? styles.scrolled : ''}`}>
      <div className="page">
        <div className={styles.inner}>
          <Link href="/" className={styles.brand}>
            {dict.brand.name}
            <span className={styles.brandTag}>{dict.brand.tagline}</span>
          </Link>

          {searchSlot ? (
            <div className={`${styles.searchSlot} ${isHome ? '' : styles.searchSlotVisible}`}>
              {searchSlot}
            </div>
          ) : null}

          <nav className={styles.desktopNav} aria-label={dict.nav.menu}>
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`${styles.navLink} ${
                  pathname.startsWith(link.href) ? styles.navLinkActive : ''
                }`}
              >
                {link.label}
              </Link>
            ))}
            {isAdmin ? (
              <Link
                href="/admin"
                className={`${styles.navLink} ${
                  pathname.startsWith('/admin') ? styles.navLinkActive : ''
                }`}
              >
                {dict.nav.admin}
              </Link>
            ) : null}
          </nav>

          <div className={styles.actions}>
            {authenticated ? (
              <Button
                as="link"
                href="/account"
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={dict.nav.account}
              >
                <BookmarkIcon />
              </Button>
            ) : null}

            <Button
              as="link"
              href="/account"
              variant={authenticated ? 'ghost' : 'secondary'}
              size="sm"
              {...(authenticated ? { iconOnly: true, 'aria-label': dict.nav.account } : {})}
            >
              {authenticated ? <UserIcon /> : dict.nav.signIn}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className={styles.mobileMenuButton}
              aria-label={menuOpen ? dict.nav.closeMenu : dict.nav.menu}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? <CloseIcon /> : <MenuIcon />}
            </Button>
          </div>
        </div>
      </div>

      {tabSlot ? (
        <div className={styles.tabRow}>
          <div className="page">{tabSlot}</div>
        </div>
      ) : null}

      {menuOpen ? (
        <div className={styles.mobileMenu}>
          <div className="page">
            <ul className={styles.mobileMenuList}>
              {links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={styles.navLink}>
                    {link.label}
                  </Link>
                </li>
              ))}
              {isAdmin ? (
                <li>
                  <Link href="/admin" className={styles.navLink}>
                    {dict.nav.admin}
                  </Link>
                </li>
              ) : null}
              <li>
                <Link href="/account" className={styles.navLink}>
                  {authenticated ? dict.nav.account : dict.nav.signIn}
                </Link>
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </header>
  );
}
