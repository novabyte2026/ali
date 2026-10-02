'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { type Dictionary, type Locale, dictionary, direction, localeTag } from '@/lib/i18n';

/**
 * Locale context.
 *
 * The dictionary is resolved once at the provider and read through a hook, so
 * no component imports a dictionary directly — which is what keeps every
 * string translatable and keeps the "no hardcoded UI text" rule enforceable by
 * reading the imports.
 */

interface LocaleContextValue {
  readonly locale: Locale;
  readonly dict: Dictionary;
  readonly dir: 'rtl' | 'ltr';
  readonly tag: string;
  readonly currency: string;
  readonly countryCode: string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
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
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      dict: dictionary(locale),
      dir: direction(locale),
      tag: localeTag(locale),
      currency,
      countryCode,
    }),
    [locale, currency, countryCode],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) {
    // A component outside the provider is a wiring mistake, and failing loudly
    // in development is better than silently rendering English.
    throw new Error('useLocale must be used inside a LocaleProvider');
  }
  return value;
}

/** Shorthand for the common case of only needing the dictionary. */
export function useDict(): Dictionary {
  return useLocale().dict;
}
