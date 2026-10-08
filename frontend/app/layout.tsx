import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { negotiateLocale, dictionary, direction, isLocale } from '@/lib/i18n';
import { AppShell } from '@/components/layout/AppShell';
import '@/styles/global.css';

/**
 * Root layout.
 *
 * Locale is resolved on the server from a cookie, falling back to
 * Accept-Language, so the first paint is in the right language and the right
 * direction. No client-side locale flash, and no layout shift from `dir`
 * changing after hydration.
 */

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is not disabled. Capping it is an accessibility failure, and this
  // product has dense price tables that people will want to magnify.
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#151413' },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveLocale();
  const dict = dictionary(locale);

  return {
    title: {
      default: `${dict.brand.name} — ${dict.brand.tagline}`,
      template: `%s · ${dict.brand.name}`,
    },
    description: dict.home.subheading,
    applicationName: dict.brand.name,
    // Robots is permissive for public pages; the account and admin areas set
    // their own noindex. We do not generate thousands of thin pages (rule 113).
    robots: { index: true, follow: true },
    openGraph: {
      type: 'website',
      siteName: dict.brand.name,
      title: `${dict.brand.name} — ${dict.brand.tagline}`,
      description: dict.home.subheading,
      locale: locale === 'he' ? 'he_IL' : 'en_US',
    },
    formatDetection: { telephone: false, address: false, email: false },
  };
}

export default async function RootLayout({ children }: { readonly children: React.ReactNode }) {
  const locale = await resolveLocale();
  const dir = direction(locale);
  const cookieStore = await cookies();

  const currency = cookieStore.get('shelf_currency')?.value ?? defaultCurrencyFor(locale);
  const countryCode = cookieStore.get('shelf_country')?.value ?? defaultCountryFor(locale);
  const reducedMotion = cookieStore.get('shelf_reduced_motion')?.value === 'true';

  return (
    <html lang={locale} dir={dir} data-reduced-motion={reducedMotion ? 'true' : undefined}>
      <body>
        <AppShell locale={locale} currency={currency} countryCode={countryCode}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}

async function resolveLocale() {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get('shelf_locale')?.value;
  if (isLocale(fromCookie)) return fromCookie;

  const headerStore = await headers();
  return negotiateLocale(headerStore.get('accept-language'));
}

function defaultCurrencyFor(locale: string): string {
  return locale === 'he' ? 'ILS' : 'USD';
}

function defaultCountryFor(locale: string): string {
  return locale === 'he' ? 'IL' : 'US';
}
