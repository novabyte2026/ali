import type { Datum } from '../datum.js';
import type { MatchResult } from '../match.js';
import type { ProviderId } from './provider.js';
import type { NormalizedOffer } from './offer.js';

/**
 * Structured identifiers. These are what make honest cross-source matching
 * possible; everything else is inference. Each is optional because most
 * marketplace listings carry none of them.
 */
export interface ProductIdentifiers {
  /** GTIN-8/12/13/14, normalized to 14 digits. Covers UPC/EAN/ISBN. */
  readonly gtin?: string;
  /** Manufacturer part number, uppercased and stripped of separators. */
  readonly mpn?: string;
  /** Brand-assigned model designation as printed on the product. */
  readonly model?: string;
  /** Provider-native id (ASIN, AliExpress product id, Temu goods id). */
  readonly providerProductId: string;
  /** Provider-native variant/SKU id when the listing is variant-level. */
  readonly providerVariantId?: string;
}

/** Attributes that distinguish variants of one model. Order matters for keys. */
export const VARIANT_ATTRIBUTE_KEYS = [
  'capacity',
  'size',
  'colour',
  'material',
  'length',
  'wattage',
  'count',
  'region',
  'connectivity',
] as const;

export type VariantAttributeKey = (typeof VARIANT_ATTRIBUTE_KEYS)[number];

export interface VariantAttribute {
  readonly key: VariantAttributeKey;
  /** Canonical value used for matching, e.g. '128GB', 'BLACK'. */
  readonly normalized: string;
  /** The provider's own wording, preserved for display. */
  readonly raw: string;
}

export interface ProductImage {
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
  /**
   * Whether we hold permission to display this image. Images arriving from a
   * provider whose `productImages` capability is not AVAILABLE are dropped at
   * the adapter boundary, so a `false` here is a bug and the renderer skips it.
   */
  readonly displayPermitted: boolean;
}

export interface SpecificationEntry {
  /** Canonical key, e.g. 'battery_life_hours'. */
  readonly key: string;
  /** Provider's label, for display when we have no translation. */
  readonly label: string;
  readonly value: string;
  readonly unit: string | null;
}

/**
 * One listing from one provider, mapped into our vocabulary.
 *
 * `raw` is retained alongside the normalized view because normalization is
 * lossy and the admin product debugger must be able to show exactly what the
 * provider said. It is never sent to a non-admin client.
 */
export interface NormalizedProduct {
  readonly providerId: ProviderId;
  readonly identifiers: ProductIdentifiers;

  /** Cleaned title: marketing noise trimmed, original kept in `rawTitle`. */
  readonly title: string;
  readonly rawTitle: string;
  readonly brand: Datum<string>;
  readonly category: Datum<string>;
  /** Our internal taxonomy path, e.g. ['audio','headphones','true-wireless']. */
  readonly categoryPath: ReadonlyArray<string>;

  readonly variantAttributes: ReadonlyArray<VariantAttribute>;
  readonly specifications: ReadonlyArray<SpecificationEntry>;
  readonly images: ReadonlyArray<ProductImage>;

  readonly rating: Datum<number>;
  readonly reviewCount: Datum<number>;

  /** Canonical product URL at the provider, before affiliate wrapping. */
  readonly sourceUrl: string;

  /** Provider payload, admin-only. */
  readonly raw?: Record<string, unknown>;
}

/**
 * A product identity we have decided is one thing, with the offers we found
 * for it across sources. This is what turns three search engines into one
 * comparison engine.
 */
export interface ProductGroup {
  /** Stable id derived from the strongest identifier available. */
  readonly groupId: string;
  readonly title: string;
  readonly brand: Datum<string>;
  readonly categoryPath: ReadonlyArray<string>;
  readonly identifiers: {
    readonly gtin?: string;
    readonly mpn?: string;
    readonly model?: string;
  };
  readonly variantAttributes: ReadonlyArray<VariantAttribute>;
  readonly primaryImage: ProductImage | null;

  /** One entry per provider offer, each with its match back to the group. */
  readonly offerings: ReadonlyArray<ProductGroupOffering>;

  /**
   * Whether every offering is identifier-backed. Only then may the UI present
   * the offerings as price rows for a single product.
   */
  readonly comparableAcrossSources: boolean;
  readonly providerIds: ReadonlyArray<ProviderId>;
}

export interface ProductGroupOffering {
  readonly providerId: ProviderId;
  readonly product: NormalizedProduct;
  readonly offer: NormalizedOffer;
  readonly match: MatchResult;
}

export function groupKeyFromIdentifiers(identifiers: ProductIdentifiers): string | null {
  if (identifiers.gtin) return `gtin:${identifiers.gtin}`;
  if (identifiers.mpn && identifiers.model) {
    return `mpn:${identifiers.mpn}`;
  }
  return null;
}
