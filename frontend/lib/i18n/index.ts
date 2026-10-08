import { type Dictionary, he } from './he';
import { en } from './en';

/**
 * Locale resolution.
 *
 * Hebrew is the default because that is the primary market, and the whole
 * interface is laid out with logical CSS properties (inline-start, margin-inline)
 * so RTL is the native case rather than a mirrored afterthought.
 *
 * No text is hardcoded in a component. Everything renders from a dictionary,
 * which is also what makes the copy reviewable in one place — including the
 * part of the copy that matters most here, the wording used when a value is
 * unknown.
 */

export type Locale = 'he' | 'en';

const DICTIONARIES: Record<Locale, Dictionary> = { he, en };

export const DEFAULT_LOCALE: Locale = 'he';

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'he' || value === 'en';
}

export function dictionary(locale: string | undefined | null): Dictionary {
  return isLocale(locale) ? DICTIONARIES[locale] : DICTIONARIES[DEFAULT_LOCALE];
}

export function direction(locale: string | undefined | null): 'rtl' | 'ltr' {
  return isLocale(locale) && locale === 'he' ? 'rtl' : 'ltr';
}

export function localeTag(locale: string | undefined | null): string {
  return isLocale(locale) && locale === 'he' ? 'he-IL' : 'en-US';
}

/** Picks a locale from an Accept-Language header. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const entries = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, qualityPart] = part.trim().split(';q=');
      return { tag: (tag ?? '').trim().toLowerCase(), quality: Number.parseFloat(qualityPart ?? '1') };
    })
    .filter((entry) => entry.tag.length > 0 && Number.isFinite(entry.quality))
    .sort((a, b) => b.quality - a.quality);

  for (const entry of entries) {
    const base = entry.tag.split('-')[0];
    if (base === 'he' || base === 'iw') return 'he';
    if (base === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}

/**
 * Resolves a dotted translation key, as returned by the API.
 *
 * The backend sends keys like `capability.coupons.VERIFICATION_REQUIRED` rather
 * than prose, so that the explanation for a refusal is localized and reviewed
 * here rather than being assembled on the server. An unresolved key returns
 * `undefined` so the caller can choose a sensible fallback instead of printing
 * the token at a user.
 */
export function resolveKey(dict: Dictionary, key: string): string | undefined {
  // Capability keys are `capability.<name>.<STATE>`; the message depends only
  // on the state, so they are mapped before the generic walk.
  const capabilityMatch = key.match(/^capability\.[a-zA-Z]+\.([A-Z_]+)$/);
  if (capabilityMatch) {
    const state = capabilityMatch[1] as keyof Dictionary['capability']['reasons'];
    return dict.capability.reasons[state];
  }

  let node: unknown = dict;
  for (const segment of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

export type { Dictionary };
export { he, en };
