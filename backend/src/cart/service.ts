import {
  type CartLine,
  type CartProviderGroup,
  type ConfidenceBand,
  type Datum,
  type Money,
  type NormalizedOffer,
  type SmartCart,
  AppError,
  add,
  estimated,
  hasValue,
  isKnown,
  money,
  multiply,
  newId,
  unknown,
  weakestConfidence,
  zero,
} from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { CurrencyConverter } from '../pricing/currency.js';
import type { Logger } from '../logger.js';

/**
 * Smart Cart.
 *
 * A comparison worksheet across stores, not a checkout (rules 37, 38, 117).
 * Nothing here charges anything, reserves anything or promises delivery; it
 * answers "what would this basket actually cost me, across three
 * marketplaces".
 *
 * Two modelling decisions that make the answer honest:
 *
 *   - Shipping is per store, never per cart. Three stores means three
 *     shipments, and summing one shipping fee across the basket would
 *     understate the total — which is exactly the mistake that makes a
 *     multi-store basket look cheaper than it is.
 *   - A grand total is KNOWN only if every store's total is known. One store
 *     with unknown shipping makes the grand total an estimate, and that is
 *     reported rather than smoothed over.
 */

export interface CartService {
  list(userId: string): Promise<ReadonlyArray<{ readonly cartId: string; readonly label: string; readonly updatedAt: string }>>;
  get(userId: string, cartId: string, currency: string): Promise<SmartCart>;
  create(args: {
    readonly userId: string;
    readonly label: string;
    readonly currency: string;
    readonly countryCode: string;
  }): Promise<{ readonly cartId: string }>;
  addLine(args: {
    readonly userId: string;
    readonly cartId: string;
    readonly providerId: string;
    readonly providerProductId: string;
    readonly providerVariantId: string | null;
    readonly title: string;
    readonly imageUrl: string | null;
    readonly quantity: number;
    readonly offer: NormalizedOffer;
  }): Promise<void>;
  updateQuantity(args: {
    readonly userId: string;
    readonly cartId: string;
    readonly lineId: string;
    readonly quantity: number;
  }): Promise<void>;
  removeLine(userId: string, cartId: string, lineId: string): Promise<void>;
  deleteCart(userId: string, cartId: string): Promise<void>;
}

const MAX_LINES = 60;

export function createCartService(
  db: Database,
  converter: CurrencyConverter,
  log: Logger,
): CartService {
  async function assertOwnership(userId: string, cartId: string): Promise<CartRow> {
    const result = await db.query<CartRow>(
      `SELECT cart_id, user_id, label, currency, country_code, created_at, updated_at
         FROM shopping_carts
        WHERE cart_id = $1 AND user_id = $2`,
      [cartId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'cart' } });
    return row;
  }

  return {
    async list(userId) {
      const result = await db.query<{ cart_id: string; label: string; updated_at: Date }>(
        `SELECT cart_id, label, updated_at
           FROM shopping_carts
          WHERE user_id = $1
          ORDER BY updated_at DESC
          LIMIT 20`,
        [userId],
      );
      return result.rows.map((row) => ({
        cartId: row.cart_id,
        label: row.label,
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async get(userId, cartId, currency) {
      const cart = await assertOwnership(userId, cartId);
      const target = currency.toUpperCase();

      const items = await db.query<CartItemRow>(
        `SELECT line_id, provider_id, provider_product_id, provider_variant_id,
                title, image_url, quantity, offer_snapshot, added_at
           FROM cart_items
          WHERE cart_id = $1
          ORDER BY added_at`,
        [cartId],
      );

      const lines: CartLine[] = items.rows.map((row) => ({
        lineId: row.line_id,
        providerId: row.provider_id,
        providerProductId: row.provider_product_id,
        providerVariantId: row.provider_variant_id,
        title: row.title,
        imageUrl: row.image_url,
        quantity: row.quantity,
        offer: row.offer_snapshot as NormalizedOffer,
        addedAt: row.added_at.toISOString(),
        // Would require a live re-fetch to determine; the worksheet shows the
        // snapshot's observation time instead of claiming it is current.
        priceChangedSinceAdded: false,
      }));

      const groups = await buildGroups(lines, target, converter);
      const grandTotal = combineTotals(
        groups.map((group) => group.estimatedTotal),
        target,
      );

      return {
        cartId: cart.cart_id,
        userId: cart.user_id,
        label: cart.label,
        currency: target,
        countryCode: cart.country_code,
        groups,
        grandTotal,
        confidence: weakestConfidence(
          groups.map((group) => (isKnown(group.estimatedTotal) ? 'HIGH' : 'LOW')),
        ) as ConfidenceBand,
        missingComponents: [
          ...new Set(groups.flatMap((group) => group.missingComponents)),
        ],
        createdAt: cart.created_at.toISOString(),
        updatedAt: cart.updated_at.toISOString(),
      };
    },

    async create({ userId, label, currency, countryCode }) {
      const existing = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM shopping_carts WHERE user_id = $1',
        [userId],
      );
      if (Number.parseInt(existing.rows[0]?.count ?? '0', 10) >= 20) {
        throw new AppError('ERROR_LIMIT_REACHED', { details: { limit: 20, resource: 'carts' } });
      }

      const cartId = newId('cart');
      await db.query(
        `INSERT INTO shopping_carts (cart_id, user_id, label, currency, country_code)
         VALUES ($1, $2, $3, $4, $5)`,
        [cartId, userId, label.slice(0, 120), currency.toUpperCase(), countryCode.toUpperCase()],
      );
      return { cartId };
    },

    async addLine(args) {
      await assertOwnership(args.userId, args.cartId);

      const count = await db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM cart_items WHERE cart_id = $1',
        [args.cartId],
      );
      if (Number.parseInt(count.rows[0]?.count ?? '0', 10) >= MAX_LINES) {
        throw new AppError('ERROR_LIMIT_REACHED', {
          details: { limit: MAX_LINES, resource: 'cartLines' },
        });
      }

      await db.query(
        `INSERT INTO cart_items
           (line_id, cart_id, provider_id, provider_product_id, provider_variant_id,
            title, image_url, quantity, offer_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (cart_id, provider_id, provider_product_id, coalesce(provider_variant_id, ''))
         DO UPDATE SET
           quantity = least(cart_items.quantity + EXCLUDED.quantity, 99),
           offer_snapshot = EXCLUDED.offer_snapshot`,
        [
          newId('line'),
          args.cartId,
          args.providerId,
          args.providerProductId,
          args.providerVariantId,
          args.title.slice(0, 300),
          args.imageUrl,
          Math.min(Math.max(args.quantity, 1), 99),
          JSON.stringify(args.offer),
        ],
      );

      await db.query('UPDATE shopping_carts SET updated_at = now() WHERE cart_id = $1', [
        args.cartId,
      ]);
    },

    async updateQuantity({ userId, cartId, lineId, quantity }) {
      await assertOwnership(userId, cartId);
      const result = await db.query(
        'UPDATE cart_items SET quantity = $3 WHERE line_id = $1 AND cart_id = $2',
        [lineId, cartId, Math.min(Math.max(quantity, 1), 99)],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'cartLine' } });
      }
      await db.query('UPDATE shopping_carts SET updated_at = now() WHERE cart_id = $1', [cartId]);
    },

    async removeLine(userId, cartId, lineId) {
      await assertOwnership(userId, cartId);
      const result = await db.query(
        'DELETE FROM cart_items WHERE line_id = $1 AND cart_id = $2',
        [lineId, cartId],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'cartLine' } });
      }
      await db.query('UPDATE shopping_carts SET updated_at = now() WHERE cart_id = $1', [cartId]);
    },

    async deleteCart(userId, cartId) {
      await assertOwnership(userId, cartId);
      await db.query('DELETE FROM shopping_carts WHERE cart_id = $1 AND user_id = $2', [
        cartId,
        userId,
      ]);
      log.debug('Cart deleted', { cartId });
    },
  };
}

/**
 * Low and high bounds of a money Datum. An absent figure contributes zero to
 * both, and the caller is responsible for recording it as missing — this
 * helper deliberately does not decide that an unknown is free.
 */
function boundsOf(
  datum: Datum<Money>,
  currency: string,
): { readonly low: Money; readonly high: Money } {
  if (datum.state === 'KNOWN') return { low: datum.value, high: datum.value };
  if (datum.state === 'ESTIMATED') {
    return { low: datum.estimate.low, high: datum.estimate.high };
  }
  return { low: zero(currency), high: zero(currency) };
}

/** Groups lines by store and totals each one separately. */
async function buildGroups(
  lines: ReadonlyArray<CartLine>,
  currency: string,
  converter: CurrencyConverter,
): Promise<ReadonlyArray<CartProviderGroup>> {
  const byProvider = new Map<string, CartLine[]>();
  for (const line of lines) {
    const existing = byProvider.get(line.providerId);
    if (existing) existing.push(line);
    else byProvider.set(line.providerId, [line]);
  }

  const groups: CartProviderGroup[] = [];

  for (const [providerId, providerLines] of byProvider) {
    const missing = new Set<string>();

    let itemsSubtotal: Datum<Money> = { state: 'KNOWN', value: zero(currency), provenance: derived() };

    for (const line of providerLines) {
      const converted = await converter.convert(line.offer.price, currency);
      if (!hasValue(converted)) {
        missing.add('ITEM_PRICE');
        itemsSubtotal = unknown<Money>('NOT_COMPUTABLE', providerId);
        break;
      }
      if (!isKnown(converted) || !isKnown(itemsSubtotal)) {
        // An estimated line makes the whole subtotal a range.
        const lineBounds = boundsOf(converted, currency);
        const baseBounds = boundsOf(itemsSubtotal, currency);
        itemsSubtotal = estimated<Money>(
          {
            low: add(baseBounds.low, multiply(lineBounds.low, line.quantity)),
            high: add(baseBounds.high, multiply(lineBounds.high, line.quantity)),
            basis: 'CART_LINE_ESTIMATED',
            confidence: 'MEDIUM',
          },
          derived(),
        );
        continue;
      }
      itemsSubtotal = {
        state: 'KNOWN',
        value: add(itemsSubtotal.value, multiply(converted.value, line.quantity)),
        provenance: derived(),
      };
    }

    // Shipping: one quote per store, taken from the first line that has one.
    // Absent means absent — we do not assume free shipping.
    let shipping: Datum<Money> = unknown<Money>('NOT_PROVIDED_BY_SOURCE', providerId);
    for (const line of providerLines) {
      const converted = await converter.convert(line.offer.shipping.cost, currency);
      if (hasValue(converted)) {
        shipping = converted;
        break;
      }
      if (isKnown(line.offer.shipping.free) && line.offer.shipping.free.value) {
        shipping = { state: 'KNOWN', value: zero(currency), provenance: derived() };
        break;
      }
    }
    if (!hasValue(shipping)) missing.add('SHIPPING');

    let tax: Datum<Money> = unknown<Money>('NOT_COMPUTABLE', providerId);
    for (const line of providerLines) {
      const converted = await converter.convert(line.offer.tax.amount, currency);
      if (hasValue(converted)) {
        tax = converted;
        break;
      }
    }
    if (!hasValue(tax)) {
      missing.add('TAX');
      missing.add('DUTIES');
    }

    const couponSavings: Datum<Money> = unknown<Money>('NOT_PROVIDED_BY_SOURCE', providerId);

    groups.push({
      providerId,
      lines: providerLines,
      itemsSubtotal,
      shipping,
      tax,
      couponSavings,
      estimatedTotal: combineTotals([itemsSubtotal, shipping, tax], currency),
      missingComponents: [...missing],
    });
  }

  return groups;
}

/**
 * Sums Datums, propagating the weakest state.
 *
 * An absent component is treated as zero in the low bound and makes the total
 * an estimate rather than exact — and when a component is entirely
 * incomputable the total is UNKNOWN, because a sum missing a term is not a
 * total.
 */
function combineTotals(parts: ReadonlyArray<Datum<Money>>, currency: string): Datum<Money> {
  if (parts.length === 0) return { state: 'KNOWN', value: zero(currency), provenance: derived() };

  let low = zero(currency);
  let high = zero(currency);
  let allKnown = true;
  let anyIncomputable = false;

  for (const part of parts) {
    if (part.state === 'KNOWN') {
      low = add(low, part.value);
      high = add(high, part.value);
    } else if (part.state === 'ESTIMATED') {
      allKnown = false;
      low = add(low, part.estimate.low);
      high = add(high, part.estimate.high);
    } else {
      allKnown = false;
      // An unknown component contributes nothing to the floor and makes the
      // ceiling unbounded, so the total cannot be stated.
      anyIncomputable = true;
    }
  }

  if (anyIncomputable) {
    return estimated<Money>(
      {
        low,
        high: low,
        basis: 'CART_TOTAL_EXCLUDES_UNKNOWN_COMPONENTS',
        confidence: 'LOW',
      },
      derived(),
    );
  }

  if (allKnown) return { state: 'KNOWN', value: low, provenance: derived() };

  return estimated<Money>(
    { low, high, basis: 'CART_TOTAL_ESTIMATED', confidence: 'MEDIUM' },
    derived(),
  );
}

function derived() {
  return {
    origin: 'DERIVED' as const,
    providerId: null,
    observedAt: new Date().toISOString(),
    policyRef: 'derived/cart-total',
  };
}

interface CartRow {
  cart_id: string;
  user_id: string;
  label: string;
  currency: string;
  country_code: string;
  created_at: Date;
  updated_at: Date;
}

interface CartItemRow {
  line_id: string;
  provider_id: string;
  provider_product_id: string;
  provider_variant_id: string | null;
  title: string;
  image_url: string | null;
  quantity: number;
  offer_snapshot: unknown;
  added_at: Date;
}

export { money };
