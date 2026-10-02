'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { Locale } from '@/lib/i18n';
import { LocaleProvider, useLocale } from '@/components/LocaleProvider';
import { fetchAuthState, fetchProviders, type ProvidersResponse } from '@/lib/api';
import { Header } from './Header';
import { Footer } from './Footer';
import { DemoBanner } from './DemoBanner';
import { ScrollProgress } from './ScrollProgress';
import { ProvidersProvider } from './ProvidersProvider';

/**
 * Application shell.
 *
 * Fetches the provider capability map and the auth state once and shares them
 * through context, because almost every component needs to know what a source
 * can do before it decides what to render — and a request per component would
 * be both slow and inconsistent within a single page.
 *
 * Both fetches degrade: if the API is unreachable, the shell still renders and
 * the page below shows its own error state. A failed capability lookup is
 * treated as "nothing is available", which is the safe direction — it hides
 * features rather than offering ones that would fail.
 */

export function AppShell({
  locale,
  currency,
  countryCode,
  children,
}: {
  readonly locale: Locale;
  readonly currency: string;
  readonly countryCode: string;
  readonly children: ReactNode;
}) {
  return (
    <LocaleProvider locale={locale} currency={currency} countryCode={countryCode}>
      <ShellBody>{children}</ShellBody>
    </LocaleProvider>
  );
}

function ShellBody({ children }: { readonly children: ReactNode }) {
  const { dict } = useLocale();
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void fetchProviders(controller.signal)
      .then(setProviders)
      .catch(() => setProviders(null));

    void fetchAuthState(controller.signal)
      .then((state) => {
        setAuthenticated(state.authenticated);
        setIsAdmin(state.role === 'admin');
      })
      .catch(() => {
        setAuthenticated(false);
        setIsAdmin(false);
      });

    return () => controller.abort();
  }, []);

  const demoProviderIds =
    providers?.providers.filter((entry) => entry.servingDemoFixtures).map((entry) => entry.id) ??
    [];

  const programmes =
    providers?.providers.map((entry) => ({
      providerId: entry.id,
      programmeName: entry.branding.displayName,
      displayName: entry.branding.displayName,
    })) ?? [];

  return (
    <ProvidersProvider value={providers}>
      <ScrollProgress />

      <a className="skip-link" href="#main">
        {dict.nav.skipToContent}
      </a>

      {demoProviderIds.length > 0 ? <DemoBanner providerIds={demoProviderIds} /> : null}

      <Header authenticated={authenticated} isAdmin={isAdmin} />

      <main id="main">{children}</main>

      <Footer programmes={programmes} />
    </ProvidersProvider>
  );
}
