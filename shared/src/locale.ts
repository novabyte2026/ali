/**
 * Locale, country and currency support.
 *
 * Country is not a cosmetic preference here — it changes which marketplace
 * domain an affiliate link points at, whether a provider ships at all, which
 * currency prices arrive in, and whether a tax estimate is even possible. It
 * is therefore part of the search key and part of the cache key.
 */

export const SUPPORTED_LOCALES = ['he', 'en'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const RTL_LOCALES = new Set<string>(['he', 'ar', 'fa', 'ur']);

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function textDirection(locale: string): 'rtl' | 'ltr' {
  return RTL_LOCALES.has(locale.split('-')[0] ?? locale) ? 'rtl' : 'ltr';
}

export interface CountryConfig {
  readonly code: string;
  readonly defaultCurrency: string;
  readonly defaultLocale: Locale;
  /**
   * Standard consumption-tax rate, used only to produce clearly-labelled
   * ESTIMATED figures. Import thresholds, duty and carrier handling fees are
   * not modelled: they depend on the shipment, so the honest output is a range
   * or nothing at all.
   */
  readonly vatRate: number | null;
  /** De-minimis import value below which VAT is typically not collected. */
  readonly importVatThresholdMinor: number | null;
}

export const COUNTRIES: ReadonlyArray<CountryConfig> = [
  { code: 'IL', defaultCurrency: 'ILS', defaultLocale: 'he', vatRate: 0.18, importVatThresholdMinor: 7500 },
  { code: 'US', defaultCurrency: 'USD', defaultLocale: 'en', vatRate: null, importVatThresholdMinor: null },
  { code: 'GB', defaultCurrency: 'GBP', defaultLocale: 'en', vatRate: 0.2, importVatThresholdMinor: 0 },
  { code: 'DE', defaultCurrency: 'EUR', defaultLocale: 'en', vatRate: 0.19, importVatThresholdMinor: 0 },
  { code: 'FR', defaultCurrency: 'EUR', defaultLocale: 'en', vatRate: 0.2, importVatThresholdMinor: 0 },
  { code: 'ES', defaultCurrency: 'EUR', defaultLocale: 'en', vatRate: 0.21, importVatThresholdMinor: 0 },
  { code: 'IT', defaultCurrency: 'EUR', defaultLocale: 'en', vatRate: 0.22, importVatThresholdMinor: 0 },
  { code: 'NL', defaultCurrency: 'EUR', defaultLocale: 'en', vatRate: 0.21, importVatThresholdMinor: 0 },
  { code: 'CA', defaultCurrency: 'CAD', defaultLocale: 'en', vatRate: 0.05, importVatThresholdMinor: 2000 },
  { code: 'AU', defaultCurrency: 'AUD', defaultLocale: 'en', vatRate: 0.1, importVatThresholdMinor: 100000 },
];

const COUNTRY_INDEX = new Map(COUNTRIES.map((country) => [country.code, country]));

export function countryConfig(code: string): CountryConfig | undefined {
  return COUNTRY_INDEX.get(code.toUpperCase());
}

export function isSupportedCountry(code: string): boolean {
  return COUNTRY_INDEX.has(code.toUpperCase());
}

export const SUPPORTED_CURRENCIES = [
  'ILS',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: string): boolean {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

/** Currency symbols recognized when parsing a budget out of free text. */
export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  '₪': 'ILS',
  'ש"ח': 'ILS',
  'שח': 'ILS',
  'שקל': 'ILS',
  'שקלים': 'ILS',
  nis: 'ILS',
  ils: 'ILS',
  $: 'USD',
  usd: 'USD',
  'דולר': 'USD',
  '€': 'EUR',
  eur: 'EUR',
  'יורו': 'EUR',
  'אירו': 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
};

export function resolveLocaleTag(locale: string): string {
  return locale === 'he' ? 'he-IL' : 'en-US';
}
