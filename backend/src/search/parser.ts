import {
  type CurrencyCode,
  type Money,
  type QueryIntent,
  type SortOption,
  CURRENCY_SYMBOLS,
  countryConfig,
  escapeRegExp,
  extractModelCandidates,
  moneyFromDecimal,
  normalizeCapacity,
  normalizeColour,
  normalizeMilliampHours,
  normalizeText,
  normalizeWattage,
  toAsciiDigits,
} from '@shelf/shared';

/**
 * Natural-language query parsing, Hebrew and English.
 *
 * The job is to turn "אוזניות אלחוטיות עד 150 ₪ עם דירוג 4+" into a keyword
 * string plus structured constraints, and — just as importantly — to report
 * exactly what it recognized so the UI can show the user and let them remove
 * any of it. A parser that silently applies a constraint the user did not
 * intend is worse than one that applies none.
 *
 * Deliberate limits:
 *   - Nothing is inferred that was not said. No category is guessed from a
 *     keyword, no budget is invented, no rating floor is assumed.
 *   - Recognized spans are removed from the keyword string so providers get
 *     "wireless headphones" rather than "wireless headphones up to 150".
 *   - Where a phrase is ambiguous between a price and a specification
 *     ("65W charger up to 80") the unit-bearing token wins and is kept as a
 *     variant hint, because "65W" is part of the product and "80" is the
 *     budget.
 */

export interface ParseOptions {
  readonly countryCode: string;
  readonly currency: string;
  readonly locale: string;
  /** Provider ids that exist, so in-text source mentions can be validated. */
  readonly knownProviderIds: ReadonlyArray<string>;
}

interface Recognition {
  readonly kind: string;
  readonly text: string;
  readonly valueLabel: string;
  readonly start: number;
  readonly end: number;
}

export function parseQuery(rawQuery: string, options: ParseOptions): QueryIntent {
  const original = rawQuery.trim();
  const working = toAsciiDigits(original);
  const recognitions: Recognition[] = [];

  const language = detectLanguage(original);

  const providerMentions = findProviderMentions(working, options.knownProviderIds, recognitions);
  const budget = findBudget(working, options.currency, recognitions);
  const rating = findMinRating(working, recognitions);
  const reviews = findMinReviewCount(working, recognitions);
  const shipping = findShippingPreference(working, recognitions);
  const coupon = findCouponRequirement(working, recognitions);
  const sameProduct = findSameProductRequirement(working, recognitions);
  const sort = findSortPreference(working, recognitions);
  const variantHints = findVariantHints(working, recognitions);
  const brandAndModel = findBrandAndModel(working);

  const keywords = stripRecognized(working, recognitions);

  return {
    keywords: keywords.length > 0 ? keywords : original,
    rawQuery: original,
    detectedLanguage: language,
    ...(brandAndModel.brand ? { brand: brandAndModel.brand } : {}),
    ...(brandAndModel.model ? { model: brandAndModel.model } : {}),
    ...(budget.min ? { budgetMin: budget.min } : {}),
    ...(budget.max ? { budgetMax: budget.max } : {}),
    budgetIsHardLimit: budget.isHardLimit,
    ...(rating === undefined ? {} : { minRating: rating }),
    ...(reviews === undefined ? {} : { minReviewCount: reviews }),
    variantHints,
    ...(shipping === undefined ? {} : { shippingPreference: shipping }),
    ...(coupon === undefined ? {} : { requiresCoupon: coupon }),
    ...(sameProduct === undefined ? {} : { sameProductOnly: sameProduct }),
    countryCode: options.countryCode.toUpperCase(),
    currency: options.currency.toUpperCase(),
    requestedProviderIds: providerMentions,
    ...(sort === undefined ? {} : { sortPreference: sort }),
    recognized: recognitions.map((entry) => ({
      kind: entry.kind,
      text: entry.text,
      valueLabel: entry.valueLabel,
    })),
  };
}

function detectLanguage(text: string): 'he' | 'en' | 'unknown' {
  const hebrew = (text.match(/[֐-׿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (hebrew === 0 && latin === 0) return 'unknown';
  // A Hebrew query routinely contains Latin brand names, so Hebrew wins on
  // any meaningful presence rather than on a majority.
  if (hebrew >= 2) return 'he';
  return latin > 0 ? 'en' : 'unknown';
}

// --- Budget ---------------------------------------------------------------

const UPPER_BOUND_PHRASES = [
  'עד',
  'מתחת ל',
  'לא יותר מ',
  'מקסימום',
  'up to',
  'under',
  'below',
  'less than',
  'no more than',
  'max',
  'maximum',
  'cheaper than',
];

const LOWER_BOUND_PHRASES = ['מעל', 'יותר מ', 'מינימום', 'over', 'above', 'at least', 'min', 'from'];

const RANGE_PHRASES: ReadonlyArray<[string, string]> = [
  ['בין', 'ל'],
  ['between', 'and'],
  ['from', 'to'],
];

interface BudgetResult {
  readonly min: Money | null;
  readonly max: Money | null;
  readonly isHardLimit: boolean;
}

/**
 * Finds a budget.
 *
 * `isHardLimit` is true when the user named a ceiling. That distinction drives
 * ranking: a stated ceiling is a hard filter, and a product above it does not
 * appear in the normal result set at all (rules 9, 230). Without it we would
 * be free to show a ₪400 item for "up to ₪120" because it scored well, which
 * is the most common way comparison sites waste people's time.
 */
function findBudget(
  text: string,
  defaultCurrency: string,
  recognitions: Recognition[],
): BudgetResult {
  const currencyPattern = buildCurrencyPattern();

  // Range first: "between 100 and 200" must not be read as two bounds.
  for (const [opener, joiner] of RANGE_PHRASES) {
    const pattern = new RegExp(
      `${escapeRegExp(opener)}\\s*${currencyPattern}?\\s*(\\d[\\d,.]*)\\s*${currencyPattern}?\\s*${escapeRegExp(joiner)}\\s*${currencyPattern}?\\s*(\\d[\\d,.]*)\\s*${currencyPattern}?`,
      'i',
    );
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      const currency = firstCurrency(match) ?? defaultCurrency;
      const low = parseAmount(match[2] ?? match[1]);
      const high = parseAmount(match[4] ?? match[3]);
      const minMoney = low === null ? null : moneyFromDecimal(low, currency);
      const maxMoney = high === null ? null : moneyFromDecimal(high, currency);
      if (minMoney && maxMoney) {
        recognitions.push({
          kind: 'budget_range',
          text: match[0],
          valueLabel: `${low}–${high} ${currency}`,
          start: match.index,
          end: match.index + match[0].length,
        });
        return { min: minMoney, max: maxMoney, isHardLimit: true };
      }
    }
  }

  let min: Money | null = null;
  let max: Money | null = null;
  let isHardLimit = false;

  for (const phrase of UPPER_BOUND_PHRASES) {
    const pattern = new RegExp(
      `${escapeRegExp(phrase)}\\s*${currencyPattern}?\\s*(\\d[\\d,.]*)\\s*${currencyPattern}?`,
      'i',
    );
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    const amount = parseAmount(match[2] ?? match[1]);
    if (amount === null) continue;
    const currency = firstCurrency(match) ?? defaultCurrency;
    const money = moneyFromDecimal(amount, currency);
    if (!money) continue;
    max = money;
    isHardLimit = true;
    recognitions.push({
      kind: 'budget_max',
      text: match[0],
      valueLabel: `${amount} ${currency}`,
      start: match.index,
      end: match.index + match[0].length,
    });
    break;
  }

  for (const phrase of LOWER_BOUND_PHRASES) {
    const pattern = new RegExp(
      `${escapeRegExp(phrase)}\\s*${currencyPattern}?\\s*(\\d[\\d,.]*)\\s*${currencyPattern}?`,
      'i',
    );
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    // Do not re-read a span already consumed by an upper bound.
    if (recognitions.some((entry) => overlaps(entry, match.index!, match[0].length))) continue;
    const amount = parseAmount(match[2] ?? match[1]);
    if (amount === null) continue;
    const currency = firstCurrency(match) ?? defaultCurrency;
    const money = moneyFromDecimal(amount, currency);
    if (!money) continue;
    min = money;
    recognitions.push({
      kind: 'budget_min',
      text: match[0],
      valueLabel: `${amount} ${currency}`,
      start: match.index,
      end: match.index + match[0].length,
    });
    break;
  }

  // A bare currency amount with no bound phrase ("אוזניות 150 שקל") reads as
  // a ceiling in practice, which is how people actually type a budget.
  if (!max && !min) {
    const bare = new RegExp(`(\\d[\\d,.]*)\\s*(${currencyPattern})`, 'i');
    const match = text.match(bare);
    if (match && match.index !== undefined) {
      const amount = parseAmount(match[1]);
      const currency = resolveCurrencyToken(match[2]) ?? defaultCurrency;
      const money = amount === null ? null : moneyFromDecimal(amount, currency);
      if (money) {
        max = money;
        isHardLimit = true;
        recognitions.push({
          kind: 'budget_max',
          text: match[0],
          valueLabel: `${amount} ${currency}`,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }
  }

  return { min, max, isHardLimit };
}

function buildCurrencyPattern(): string {
  const tokens = Object.keys(CURRENCY_SYMBOLS)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  return `(${tokens.join('|')})`;
}

function firstCurrency(match: RegExpMatchArray): CurrencyCode | null {
  for (const group of match.slice(1)) {
    if (!group) continue;
    const resolved = resolveCurrencyToken(group);
    if (resolved) return resolved;
  }
  return null;
}

function resolveCurrencyToken(token: string | undefined): CurrencyCode | null {
  if (!token) return null;
  const direct = CURRENCY_SYMBOLS[token];
  if (direct) return direct;
  return CURRENCY_SYMBOLS[token.toLowerCase()] ?? null;
}

function parseAmount(raw: string | undefined): number | null {
  if (!raw) return null;
  // Thousands separators vary; a trailing ",50" is a decimal comma in several
  // locales, so only a comma followed by exactly two digits is treated as one.
  const normalized = /,\d{2}$/.test(raw)
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '');
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000_000) return null;
  return parsed;
}

// --- Rating and reviews ---------------------------------------------------

function findMinRating(text: string, recognitions: Recognition[]): number | undefined {
  const patterns: ReadonlyArray<RegExp> = [
    /(?:דירוג|ציון)\s*(?:מעל|מ|לפחות)?\s*(\d(?:[.,]\d)?)\s*\+?/i,
    /(\d(?:[.,]\d)?)\s*\+\s*(?:stars?|star|כוכבים|דירוג)/i,
    /(?:rating|rated|stars?)\s*(?:above|over|at least|of)?\s*(\d(?:[.,]\d)?)\s*\+?/i,
    /(\d(?:[.,]\d)?)\s*\+\s*$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    const value = Number.parseFloat((match[1] ?? '').replace(',', '.'));
    if (!Number.isFinite(value) || value < 1 || value > 5) continue;
    recognitions.push({
      kind: 'min_rating',
      text: match[0],
      valueLabel: `${value}+`,
      start: match.index,
      end: match.index + match[0].length,
    });
    return value;
  }
  return undefined;
}

function findMinReviewCount(text: string, recognitions: Recognition[]): number | undefined {
  const pattern =
    /(?:לפחות\s*)?(\d[\d,]*)\s*(?:\+\s*)?(?:ביקורות|reviews?|ratings?)|(?:reviews?|ביקורות)\s*(?:מעל|over|above|at least)\s*(\d[\d,]*)/i;
  const match = text.match(pattern);
  if (!match || match.index === undefined) return undefined;
  const raw = match[1] ?? match[2];
  const value = Number.parseInt((raw ?? '').replace(/,/g, ''), 10);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  recognitions.push({
    kind: 'min_reviews',
    text: match[0],
    valueLabel: `${value}+`,
    start: match.index,
    end: match.index + match[0].length,
  });
  return value;
}

// --- Preferences ----------------------------------------------------------

function findShippingPreference(
  text: string,
  recognitions: Recognition[],
): 'FREE_ONLY' | 'FAST' | 'ANY' | undefined {
  const free = text.match(/משלוח\s*חינם|free\s*(?:shipping|delivery)/i);
  if (free && free.index !== undefined) {
    recognitions.push({
      kind: 'shipping',
      text: free[0],
      valueLabel: 'free',
      start: free.index,
      end: free.index + free[0].length,
    });
    return 'FREE_ONLY';
  }
  const fast = text.match(/משלוח\s*(?:מהיר|מהיר)|fast\s*(?:shipping|delivery)|quick\s*delivery/i);
  if (fast && fast.index !== undefined) {
    recognitions.push({
      kind: 'shipping',
      text: fast[0],
      valueLabel: 'fast',
      start: fast.index,
      end: fast.index + fast[0].length,
    });
    return 'FAST';
  }
  return undefined;
}

function findCouponRequirement(text: string, recognitions: Recognition[]): boolean | undefined {
  const match = text.match(/עם\s*קופון|קופון|with\s*(?:a\s*)?coupon|coupon\s*only|promo\s*code/i);
  if (!match || match.index === undefined) return undefined;
  recognitions.push({
    kind: 'requires_coupon',
    text: match[0],
    valueLabel: 'coupon',
    start: match.index,
    end: match.index + match[0].length,
  });
  return true;
}

/**
 * Phrases that mean "the same product, cheaper" rather than "something like
 * this". The distinction is a separate user journey (rules 30, 31), so it is
 * recognized rather than inferred from intent later.
 */
function findSameProductRequirement(
  text: string,
  recognitions: Recognition[],
): boolean | undefined {
  const match = text.match(
    /(?:אותו\s*(?:מוצר|דגם)|את\s*אותו\s*(?:מוצר|דגם)|הגרסה\s*המקורית|same\s*(?:product|model|item)|exact\s*(?:same|model)|identical)/i,
  );
  if (!match || match.index === undefined) return undefined;
  recognitions.push({
    kind: 'same_product_only',
    text: match[0],
    valueLabel: 'same model',
    start: match.index,
    end: match.index + match[0].length,
  });
  return true;
}

function findSortPreference(text: string, recognitions: Recognition[]): SortOption | undefined {
  const cheapest = text.match(/(?:הזול|הכי\s*זול|זול\s*יותר|cheapest|lowest\s*price)/i);
  if (cheapest && cheapest.index !== undefined) {
    recognitions.push({
      kind: 'sort',
      text: cheapest[0],
      valueLabel: 'lowest price',
      start: cheapest.index,
      end: cheapest.index + cheapest[0].length,
    });
    return 'LOWEST_OBSERVED_PRICE';
  }
  const best = text.match(/(?:הכי\s*(?:טוב|מומלץ)|best\s*rated|highest\s*rated|top\s*rated)/i);
  if (best && best.index !== undefined) {
    recognitions.push({
      kind: 'sort',
      text: best[0],
      valueLabel: 'highest rated',
      start: best.index,
      end: best.index + best[0].length,
    });
    return 'HIGHEST_RATED';
  }
  return undefined;
}

// --- Source mentions ------------------------------------------------------

/**
 * In-text source requests. People write "תחפש גם באלי" or "יש את זה בטמו?",
 * so colloquial Hebrew short forms are recognized alongside the full names.
 */
const PROVIDER_ALIASES: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ['amazon', ['amazon', 'אמזון', 'אמאזון']],
  ['aliexpress', ['aliexpress', 'ali express', 'עליאקספרס', 'אלי אקספרס', 'אליאקספרס', 'באלי', 'אלי']],
  ['temu', ['temu', 'טמו', 'בטמו', 'טימו']],
];

function findProviderMentions(
  text: string,
  knownProviderIds: ReadonlyArray<string>,
  recognitions: Recognition[],
): string[] {
  const normalized = normalizeText(text);
  const found = new Set<string>();

  for (const [providerId, aliases] of PROVIDER_ALIASES) {
    if (!knownProviderIds.includes(providerId)) continue;
    for (const alias of aliases) {
      const pattern = new RegExp(`(^|[\\s"'(.,])${escapeRegExp(normalizeText(alias))}($|[\\s"')?.,!])`);
      const match = normalized.match(pattern);
      if (!match || match.index === undefined) continue;
      found.add(providerId);
      recognitions.push({
        kind: 'provider',
        text: alias,
        valueLabel: providerId,
        start: match.index,
        end: match.index + match[0].length,
      });
      break;
    }
  }

  return [...found];
}

// --- Variant hints and identity ------------------------------------------

/**
 * Unit-bearing tokens that identify a variant rather than a budget. Extracted
 * before the keyword string is built, and kept as hints so the matcher can use
 * them without the parser having guessed at a category.
 */
function findVariantHints(
  text: string,
  recognitions: Recognition[],
): Array<{ key: string; value: string }> {
  const hints: Array<{ key: string; value: string }> = [];

  const capacity = normalizeCapacity(text);
  if (capacity) {
    const match = text.match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb)\b/i);
    if (match && match.index !== undefined) {
      hints.push({ key: 'capacity', value: capacity });
      recognitions.push({
        kind: 'variant',
        text: match[0],
        valueLabel: capacity,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  const wattage = normalizeWattage(text);
  if (wattage) {
    const match = text.match(/(\d{1,4})\s*(w|watt|watts)\b/i);
    if (match && match.index !== undefined) {
      hints.push({ key: 'wattage', value: wattage });
      recognitions.push({
        kind: 'variant',
        text: match[0],
        valueLabel: wattage,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  const mah = normalizeMilliampHours(text);
  if (mah) {
    const match = text.match(/(\d{3,6})\s*mah\b/i);
    if (match && match.index !== undefined) {
      hints.push({ key: 'count', value: mah });
      recognitions.push({
        kind: 'variant',
        text: match[0],
        valueLabel: mah,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  const colour = normalizeColour(text);
  if (colour) hints.push({ key: 'colour', value: colour });

  return hints;
}

/**
 * Brand and model. A model candidate is only taken when the text contains a
 * token with the shape of a part number; a brand is only taken from a known
 * list, because promoting an arbitrary capitalized word to "brand" produces
 * confidently wrong matches.
 */
const KNOWN_BRANDS: ReadonlyArray<string> = [
  'anker',
  'soundcore',
  'sony',
  'samsung',
  'apple',
  'xiaomi',
  'redmi',
  'baseus',
  'ugreen',
  'jbl',
  'bose',
  'sennheiser',
  'logitech',
  'keychron',
  'razer',
  'sandisk',
  'kingston',
  'lenovo',
  'hp',
  'dell',
  'asus',
  'acer',
  'lg',
  'philips',
  'bosch',
  'dyson',
  'eufy',
  'roborock',
  'dreame',
  'tp-link',
  'netgear',
  'garmin',
  'gopro',
  'dji',
  'canon',
  'nikon',
  'nintendo',
  'microsoft',
  'google',
  'oneplus',
  'realme',
  'oppo',
  'huawei',
  'honor',
  'motorola',
  'nokia',
  'beats',
  'skullcandy',
  'jabra',
  'edifier',
  'tribit',
  'soundpeats',
];

function findBrandAndModel(text: string): { brand?: string; model?: string } {
  const normalized = normalizeText(text);
  const brand = KNOWN_BRANDS.find((candidate) =>
    new RegExp(`(^|[\\s"'(.,-])${escapeRegExp(candidate)}($|[\\s"')?.,-])`).test(normalized),
  );
  const model = extractModelCandidates(text)[0];
  return {
    ...(brand ? { brand } : {}),
    ...(model ? { model } : {}),
  };
}

// --- Keyword extraction ---------------------------------------------------

/**
 * Removes recognized spans and leftover connective words, leaving the product
 * description to send to providers.
 */
function stripRecognized(text: string, recognitions: ReadonlyArray<Recognition>): string {
  // Spans were found against different normalizations, so removal is done by
  // matching the recognized text rather than by index arithmetic, which would
  // be off by the normalization differences.
  let out = text;
  const sorted = [...recognitions].sort((a, b) => b.text.length - a.text.length);
  for (const entry of sorted) {
    if (entry.kind === 'variant') continue; // A capacity is part of the product.
    if (!entry.text) continue;
    out = out.replace(new RegExp(escapeRegExp(entry.text), 'ig'), ' ');
  }

  return out
    .replace(
      /(?:^|\s)(?:תחפש|חפש|מצא|אני\s*מחפש|אני\s*צריך|בא\s*לי|יש\s*את|תביא\s*לי|find|search|looking\s*for|i\s*(?:want|need)|show\s*me|get\s*me)(?=\s|$)/gi,
      ' ',
    )
    .replace(/(?:^|\s)(?:לי|את|גם|ב|עם|a|an|the|for|me|in|on|with|and)(?=\s|$)/gi, ' ')
    .replace(/[?!]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function overlaps(entry: Recognition, start: number, length: number): boolean {
  return !(entry.end <= start || entry.start >= start + length);
}

/**
 * Converts the parsed intent into the filters the aggregator applies. Kept
 * separate from parsing so the user's stated intent and the filters in force
 * are distinguishable in the response — the UI shows both.
 */
export function intentToFilters(intent: QueryIntent): {
  readonly priceMin?: Money;
  readonly priceMax?: Money;
  readonly minRating?: number;
  readonly minReviewCount?: number;
  readonly freeShippingOnly?: boolean;
  readonly withCouponOnly?: boolean;
  readonly exactMatchOnly?: boolean;
  readonly providerIds?: ReadonlyArray<string>;
} {
  return {
    ...(intent.budgetMin ? { priceMin: intent.budgetMin } : {}),
    ...(intent.budgetMax ? { priceMax: intent.budgetMax } : {}),
    ...(intent.minRating === undefined ? {} : { minRating: intent.minRating }),
    ...(intent.minReviewCount === undefined ? {} : { minReviewCount: intent.minReviewCount }),
    ...(intent.shippingPreference === 'FREE_ONLY' ? { freeShippingOnly: true } : {}),
    ...(intent.requiresCoupon ? { withCouponOnly: true } : {}),
    ...(intent.sameProductOnly ? { exactMatchOnly: true } : {}),
    ...(intent.requestedProviderIds.length > 0
      ? { providerIds: intent.requestedProviderIds }
      : {}),
  };
}

/** Destination country's VAT rate, for the labelled tax estimate. */
export function vatRateFor(countryCode: string): number | null {
  return countryConfig(countryCode)?.vatRate ?? null;
}
