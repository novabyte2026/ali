import type { ConfidenceBand, Datum } from '../datum.js';
import type { Money } from '../money.js';
import type { ProviderId } from './provider.js';
import type { NormalizedOffer } from './offer.js';

/**
 * The Smart Cart is a comparison worksheet, not a checkout. It lets someone
 * assemble a basket across three marketplaces and see what it adds up to —
 * then sends them to each store to actually buy.
 *
 * It must never use checkout language. "Your order has been placed" is a lie
 * we are not in a position to tell (rule 117).
 */
export interface CartLine {
  readonly lineId: string;
  readonly providerId: ProviderId;
  readonly providerProductId: string;
  readonly providerVariantId: string | null;
  readonly title: string;
  readonly imageUrl: string | null;
  readonly quantity: number;
  /** Offer snapshot at the time of adding, with its own observedAt. */
  readonly offer: NormalizedOffer;
  readonly addedAt: string;
  /** Set when a refresh found the offer changed since it was added. */
  readonly priceChangedSinceAdded: boolean;
}

/**
 * Per-provider subtotal. Shipping is per store, not per cart: three stores
 * means three shipments, and summing one shipping fee across the basket would
 * understate the cost.
 */
export interface CartProviderGroup {
  readonly providerId: ProviderId;
  readonly lines: ReadonlyArray<CartLine>;
  readonly itemsSubtotal: Datum<Money>;
  readonly shipping: Datum<Money>;
  readonly tax: Datum<Money>;
  readonly couponSavings: Datum<Money>;
  readonly estimatedTotal: Datum<Money>;
  readonly missingComponents: ReadonlyArray<string>;
}

export interface SmartCart {
  readonly cartId: string;
  readonly userId: string;
  readonly label: string;
  readonly currency: string;
  readonly countryCode: string;
  readonly groups: ReadonlyArray<CartProviderGroup>;
  /** Sum across stores. ESTIMATED whenever any group is estimated. */
  readonly grandTotal: Datum<Money>;
  readonly confidence: ConfidenceBand;
  /** Components absent anywhere in the cart, listed once. */
  readonly missingComponents: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
}
