/**
 * Text normalization shared by the product normalizer, the query parser and
 * the matching engine. These three must agree exactly: if the parser extracts
 * "128GB" and the normalizer stores "128 gb", matching silently fails and the
 * user is told two identical products are merely similar.
 */

const DIACRITICS = /[̀-֑ͯ-ֽֿׁ-ׂׄ-ׇׅ]/g;

/** Lowercase, strip diacritics and Hebrew niqqud, collapse whitespace. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Marketing noise that marketplace sellers pad titles with. Removing it before
 * comparison is what lets "Anker Soundcore Q30" match a listing titled
 * "Anker Soundcore Life Q30 Wireless Headphones, Hot Sale, Free Shipping,
 * 2024 New Arrival".
 */
const NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(hot|new|best)\s*(sale|sales|arrival|arrivals|seller|selling)\b/gi,
  /\bfree\s*(shipping|delivery)\b/gi,
  /\bfast\s*(shipping|delivery|ship)\b/gi,
  /\bdrop\s*shipping\b/gi,
  /\bwholesale\b/gi,
  /\bclearance\b/gi,
  /\blimited\s*(time|offer|stock)\b/gi,
  /\bhigh\s*quality\b/gi,
  /\b100%\s*(new|original|brand\s*new|genuine)\b/gi,
  /\bbrand\s*new\b/gi,
  /\bin\s*stock\b/gi,
  /\bready\s*to\s*ship\b/gi,
  /\bdirect\s*from\s*factory\b/gi,
  /\bfor\s*(men|women|boys|girls)\s*and\s*(men|women|boys|girls)\b/gi,
  /\b(20\d{2})\s*(new|latest|upgraded|version)\b/gi,
  /\bmultifunctional?\b/gi,
  /\bsuper\s*(deal|price|quality)\b/gi,
  /\bbig\s*(sale|discount)\b/gi,
  /\bמשלוח\s*(חינם|מהיר)\b/g,
  /\bמבצע\b/g,
  /\bחדש\s*לגמרי\b/g,
  /\bאיכות\s*(גבוהה|מעולה)\b/g,
  /\bמקורי\s*100%/g,
];

/** Bracketed and emoji-ish decoration sellers add around titles. */
const DECORATION_PATTERNS: ReadonlyArray<RegExp> = [
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu,
  /【[^】]*】/g,
  /\[[^\]]{0,24}\]/g,
  /『[^』]*』/g,
  /^[\s\-–—|•*]+/,
  /[\s\-–—|•*]+$/,
];

/**
 * A display title: decoration and marketing noise removed, original casing and
 * wording otherwise preserved. The untouched title is always kept alongside as
 * `rawTitle` — normalization is lossy and the admin debugger needs the source.
 */
export function cleanTitle(input: string): string {
  let out = input;
  for (const pattern of DECORATION_PATTERNS) out = out.replace(pattern, ' ');
  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, ' ');
  return out
    .replace(/\s*[,;]\s*(?=[,;])/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;.\-–—|]+|[\s,;.\-–—|]+$/g, '')
    .trim();
}

/** Comparison key for a title: cleaned, normalized, punctuation stripped. */
export function titleKey(input: string): string {
  return normalizeText(cleanTitle(input))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(input: string): string[] {
  return titleKey(input).split(' ').filter(Boolean);
}

/**
 * Jaccard similarity over token sets. Used as *supporting* evidence only —
 * title overlap can never on its own establish that two listings are the same
 * product (see matching/engine.ts).
 */
export function tokenSimilarity(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

// --- Identifiers ----------------------------------------------------------

/**
 * Normalizes a GTIN to 14 digits so a UPC-12, EAN-13 and GTIN-14 for the same
 * product compare equal. Validates the check digit, because an identifier that
 * fails its checksum is a data error, and matching on it would assert identity
 * on the strength of a typo.
 */
export function normalizeGtin(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  const padded = digits.padStart(14, '0');
  return gtinCheckDigitValid(padded) ? padded : null;
}

export function gtinCheckDigitValid(gtin14: string): boolean {
  if (!/^\d{14}$/.test(gtin14)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i += 1) {
    const digit = gtin14.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === gtin14.charCodeAt(13) - 48;
}

/**
 * Normalizes a manufacturer part number. Separators are inconsistent across
 * marketplaces ("WH-1000XM5", "WH1000XM5", "wh 1000 xm5") and all refer to the
 * same part, so they collapse to one key.
 */
export function normalizeMpn(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length < 3 || compact.length > 40) return null;
  // Reject values that are pure digits of identifier length: those are almost
  // always a mis-mapped GTIN rather than a part number.
  if (/^\d{8,14}$/.test(compact)) return null;
  return compact;
}

/**
 * Extracts a plausible model designation from a title. Looks for the
 * alphanumeric token shape manufacturers use (letters plus digits, or a digit
 * run with a letter suffix) rather than guessing from position.
 */
export function extractModelCandidates(title: string): string[] {
  const cleaned = cleanTitle(title);
  const candidates = new Set<string>();
  const pattern = /\b(?=[A-Za-z0-9-]{3,20}\b)(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]*\b/g;
  for (const match of cleaned.matchAll(pattern)) {
    const token = match[0];
    // Skip things that are plainly measurements or capacities.
    if (/^(\d+(gb|tb|mb|mm|cm|mah|ml|hz|khz|w|v|a|k|inch|in|ft|g|kg)|x\d+)$/i.test(token)) continue;
    if (/^20\d{2}$/.test(token)) continue;
    const normalized = normalizeMpn(token);
    if (normalized) candidates.add(normalized);
  }
  return [...candidates];
}

// --- Variant attribute values --------------------------------------------

const COLOUR_SYNONYMS: Readonly<Record<string, string>> = {
  black: 'BLACK',
  schwarz: 'BLACK',
  noir: 'BLACK',
  'שחור': 'BLACK',
  white: 'WHITE',
  blanc: 'WHITE',
  'לבן': 'WHITE',
  silver: 'SILVER',
  'כסף': 'SILVER',
  'כסוף': 'SILVER',
  grey: 'GREY',
  gray: 'GREY',
  'אפור': 'GREY',
  blue: 'BLUE',
  navy: 'BLUE',
  'כחול': 'BLUE',
  red: 'RED',
  'אדום': 'RED',
  green: 'GREEN',
  'ירוק': 'GREEN',
  gold: 'GOLD',
  'זהב': 'GOLD',
  'זהוב': 'GOLD',
  pink: 'PINK',
  rose: 'PINK',
  'ורוד': 'PINK',
  purple: 'PURPLE',
  violet: 'PURPLE',
  'סגול': 'PURPLE',
  beige: 'BEIGE',
  brown: 'BROWN',
  'חום': 'BROWN',
  orange: 'ORANGE',
  'כתום': 'ORANGE',
  yellow: 'YELLOW',
  'צהוב': 'YELLOW',
  transparent: 'TRANSPARENT',
  clear: 'TRANSPARENT',
  'שקוף': 'TRANSPARENT',
};

export function normalizeColour(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = normalizeText(input);
  for (const [token, canonical] of Object.entries(COLOUR_SYNONYMS)) {
    if (new RegExp(`(^|\\s|-)${escapeRegExp(token)}($|\\s|-)`).test(text)) return canonical;
  }
  return null;
}

/**
 * Normalizes a storage/memory capacity to a canonical token. Comparing a 128GB
 * offer against a 256GB offer as though they were the same product is the most
 * common and most damaging matching error in this domain (rule 209).
 */
export function normalizeCapacity(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = normalizeText(input).match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb|t|g)\b/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1] ?? '');
  const unit = match[2] ?? '';
  if (!Number.isFinite(amount)) return null;
  const gigabytes =
    unit === 'tb' || unit === 't'
      ? amount * 1024
      : unit === 'mb'
        ? amount / 1024
        : amount;
  if (gigabytes >= 1024 && gigabytes % 1024 === 0) return `${gigabytes / 1024}TB`;
  return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(2)}GB`;
}

/** Normalizes a battery capacity, e.g. "20000 mAh" -> "20000MAH". */
export function normalizeMilliampHours(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = normalizeText(input).match(/(\d{3,6})\s*mah\b/);
  if (!match) return null;
  return `${Number.parseInt(match[1] ?? '', 10)}MAH`;
}

/** Normalizes a power rating, e.g. "65 W" / "65 Watt" -> "65W". */
export function normalizeWattage(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = normalizeText(input).match(/(\d{1,4})\s*(w|watt|watts)\b/);
  if (!match) return null;
  return `${Number.parseInt(match[1] ?? '', 10)}W`;
}

/** Normalizes a clothing/shoe size token, e.g. "XL", "42". */
export function normalizeSize(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = normalizeText(input);
  const letter = text.match(/\b(xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl)\b/);
  if (letter) {
    const token = (letter[1] ?? '').toUpperCase();
    return token === '2XL' ? 'XXL' : token === '3XL' ? 'XXXL' : token;
  }
  const numeric = text.match(/\b(\d{1,3}(?:\.\d)?)\b/);
  return numeric ? (numeric[1] ?? null) : null;
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Canonical, order-independent key for a set of variant attributes. */
export function variantKey(
  attributes: ReadonlyArray<{ readonly key: string; readonly normalized: string }>,
): string {
  return [...attributes]
    .map((attribute) => `${attribute.key}=${attribute.normalized}`)
    .sort()
    .join(';');
}

/** Digits in Hebrew/Arabic numerals converted to ASCII for parsing. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}
