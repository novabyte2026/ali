import {
  type CouponStatus,
  type DiscountType,
  type Money,
  type NormalizedCoupon,
  money,
  newId,
  unknown,
} from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { Logger } from '../logger.js';
import { resolveStatus } from './engine.js';

/**
 * Coupon persistence.
 *
 * Coupons are the one kind of provider data we hold for longer than a request,
 * because a code's usefulness outlives the search that found it. Everything
 * written here passes through a provider's persistence capability first, and
 * carries a `purge_after` so the retention worker can enforce the policy
 * window without a second decision.
 *
 * Status is always recomputed on read (see `resolveStatus`), so a coupon
 * cannot keep displaying as verified because a stale row says so.
 */

export interface CouponStore {
  activeForProvider(
    providerId: string,
    countryCode: string,
  ): Promise<ReadonlyArray<NormalizedCoupon>>;
  forProduct(
    providerId: string,
    providerProductId: string,
    countryCode: string,
  ): Promise<ReadonlyArray<NormalizedCoupon>>;
  upsert(
    coupon: NormalizedCoupon,
    options: { readonly purgeAfter: Date | null; readonly policyVersion: string },
  ): Promise<void>;
  recordCheck(
    couponId: string,
    check: {
      readonly method: string;
      readonly result: CouponStatus;
      readonly detail?: Record<string, unknown>;
    },
  ): Promise<void>;
  /** Coupons whose last check is older than the window, for the checker job. */
  needingCheck(limit: number, olderThanMinutes: number): Promise<ReadonlyArray<NormalizedCoupon>>;
  markExpired(now?: Date): Promise<number>;
}

export function createCouponStore(db: Database, log: Logger): CouponStore {
  return {
    async activeForProvider(providerId, countryCode) {
      const result = await db.query<CouponRow>(
        `SELECT ${COUPON_COLUMNS}
           FROM coupons
          WHERE provider_id = $1
            AND status IN ('VERIFIED', 'RECENTLY_CHECKED', 'POSSIBLY_ACTIVE')
            AND (expires_at IS NULL OR expires_at > now())
            AND (starts_at IS NULL OR starts_at <= now())
            AND (cardinality(eligible_countries) = 0 OR $2 = ANY(eligible_countries))
          ORDER BY
            CASE status
              WHEN 'VERIFIED' THEN 0
              WHEN 'RECENTLY_CHECKED' THEN 1
              ELSE 2
            END,
            last_checked_at DESC NULLS LAST
          LIMIT 50`,
        [providerId, countryCode.toUpperCase()],
      );
      return result.rows.map(toCoupon);
    },

    async forProduct(providerId, providerProductId, countryCode) {
      const result = await db.query<CouponRow>(
        `SELECT ${COUPON_COLUMNS}
           FROM coupons
          WHERE provider_id = $1
            AND status IN ('VERIFIED', 'RECENTLY_CHECKED', 'POSSIBLY_ACTIVE')
            AND (expires_at IS NULL OR expires_at > now())
            AND (starts_at IS NULL OR starts_at <= now())
            AND (cardinality(eligible_countries) = 0 OR $3 = ANY(eligible_countries))
            AND (cardinality(eligible_product_ids) = 0 OR $2 = ANY(eligible_product_ids))
          ORDER BY
            -- A product-specific code is more likely to apply than a
            -- store-wide one, so it leads.
            (cardinality(eligible_product_ids) > 0) DESC,
            CASE status WHEN 'VERIFIED' THEN 0 WHEN 'RECENTLY_CHECKED' THEN 1 ELSE 2 END
          LIMIT 20`,
        [providerId, providerProductId, countryCode.toUpperCase()],
      );
      return result.rows.map(toCoupon);
    },

    async upsert(coupon, options) {
      const discountAmount = exactMoney(coupon.discountAmount);
      const minimumOrder = exactMoney(coupon.eligibility.minimumOrder);
      const expiresAt = coupon.expiresAt.state === 'KNOWN' ? coupon.expiresAt.value : null;
      const stackable =
        coupon.eligibility.stackable.state === 'KNOWN'
          ? coupon.eligibility.stackable.value
          : null;
      const discountPercent =
        coupon.discountPercent.state === 'KNOWN' ? coupon.discountPercent.value : null;

      await db.query(
        `INSERT INTO coupons (
           coupon_id, provider_id, code, title, terms,
           discount_type, discount_percent, discount_amount_minor, discount_currency,
           minimum_order_minor, minimum_order_currency,
           eligible_product_ids, eligible_category_paths, eligible_countries,
           audience, stackable, starts_at, expires_at,
           status, last_checked_at, verification_method, source_url, data_origin, purge_after
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11,
           $12, $13, $14,
           $15, $16, $17, $18,
           $19, $20, $21, $22, $23, $24
         )
         ON CONFLICT (provider_id, code) WHERE code IS NOT NULL DO UPDATE SET
           title = EXCLUDED.title,
           terms = EXCLUDED.terms,
           discount_type = EXCLUDED.discount_type,
           discount_percent = EXCLUDED.discount_percent,
           discount_amount_minor = EXCLUDED.discount_amount_minor,
           discount_currency = EXCLUDED.discount_currency,
           minimum_order_minor = EXCLUDED.minimum_order_minor,
           minimum_order_currency = EXCLUDED.minimum_order_currency,
           eligible_product_ids = EXCLUDED.eligible_product_ids,
           eligible_countries = EXCLUDED.eligible_countries,
           audience = EXCLUDED.audience,
           stackable = EXCLUDED.stackable,
           starts_at = EXCLUDED.starts_at,
           expires_at = EXCLUDED.expires_at,
           status = EXCLUDED.status,
           last_checked_at = EXCLUDED.last_checked_at,
           verification_method = EXCLUDED.verification_method,
           source_url = EXCLUDED.source_url,
           purge_after = EXCLUDED.purge_after,
           updated_at = now()`,
        [
          coupon.couponId,
          coupon.providerId,
          coupon.code,
          coupon.title,
          coupon.terms,
          coupon.discountType,
          discountPercent,
          discountAmount?.minor ?? null,
          discountAmount?.currency ?? null,
          minimumOrder?.minor ?? null,
          minimumOrder?.currency ?? null,
          coupon.eligibility.productIds,
          JSON.stringify(coupon.eligibility.categoryPaths),
          coupon.eligibility.countries,
          coupon.eligibility.audience,
          stackable,
          coupon.startsAt,
          expiresAt,
          coupon.status,
          coupon.lastCheckedAt,
          coupon.verificationMethod,
          coupon.sourceUrl,
          'PROVIDER_API',
          options.purgeAfter,
        ],
      );
    },

    async recordCheck(couponId, check) {
      await db.tx(async (client) => {
        await client.query(
          `INSERT INTO coupon_checks (check_id, coupon_id, method, result, detail)
           VALUES ($1, $2, $3, $4, $5)`,
          [newId('cck'), couponId, check.method, check.result, JSON.stringify(check.detail ?? {})],
        );
        await client.query(
          `UPDATE coupons
              SET status = $2,
                  last_checked_at = now(),
                  verification_method = $3
            WHERE coupon_id = $1`,
          [couponId, check.result, check.method],
        );
      });
      log.debug('Coupon check recorded', { couponId, result: check.result });
    },

    async needingCheck(limit, olderThanMinutes) {
      const result = await db.query<CouponRow>(
        `SELECT ${COUPON_COLUMNS}
           FROM coupons
          WHERE (expires_at IS NULL OR expires_at > now())
            AND status <> 'INVALID'
            AND verification_method <> 'NONE'
            AND (last_checked_at IS NULL
                 OR last_checked_at < now() - ($2 || ' minutes')::interval)
          ORDER BY last_checked_at NULLS FIRST
          LIMIT $1`,
        [Math.min(limit, 500), String(olderThanMinutes)],
      );
      return result.rows.map(toCoupon);
    },

    /**
     * Flips past-expiry coupons to EXPIRED. Read-time resolution already
     * handles this for display; doing it in the table as well keeps the admin
     * counts honest and lets the index on status stay useful.
     */
    async markExpired(now = new Date()) {
      const result = await db.query(
        `UPDATE coupons
            SET status = 'EXPIRED', updated_at = now()
          WHERE expires_at IS NOT NULL
            AND expires_at <= $1
            AND status <> 'EXPIRED'`,
        [now],
      );
      return result.rowCount ?? 0;
    },
  };
}

const COUPON_COLUMNS = `
  coupon_id, provider_id, code, title, terms,
  discount_type, discount_percent, discount_amount_minor, discount_currency,
  minimum_order_minor, minimum_order_currency,
  eligible_product_ids, eligible_category_paths, eligible_countries,
  audience, stackable, starts_at, expires_at,
  status, last_checked_at, verification_method, source_url
`;

interface CouponRow {
  coupon_id: string;
  provider_id: string;
  code: string | null;
  title: string;
  terms: string | null;
  discount_type: string;
  discount_percent: string | null;
  discount_amount_minor: number | null;
  discount_currency: string | null;
  minimum_order_minor: number | null;
  minimum_order_currency: string | null;
  eligible_product_ids: string[] | null;
  eligible_category_paths: unknown;
  eligible_countries: string[] | null;
  audience: string;
  stackable: boolean | null;
  starts_at: Date | null;
  expires_at: Date | null;
  status: string;
  last_checked_at: Date | null;
  verification_method: string;
  source_url: string | null;
}

function toCoupon(row: CouponRow): NormalizedCoupon {
  const provenance = {
    origin: 'PROVIDER_API' as const,
    providerId: row.provider_id,
    observedAt: (row.last_checked_at ?? new Date()).toISOString(),
  };

  const coupon: NormalizedCoupon = {
    couponId: row.coupon_id,
    providerId: row.provider_id,
    code: row.code,
    title: row.title,
    terms: row.terms,
    discountType: row.discount_type as DiscountType,
    discountPercent:
      row.discount_percent === null
        ? unknown<number>('NOT_PROVIDED_BY_SOURCE', row.provider_id)
        : { state: 'KNOWN', value: Number.parseFloat(row.discount_percent), provenance },
    discountAmount:
      row.discount_amount_minor === null || row.discount_currency === null
        ? unknown<Money>('NOT_PROVIDED_BY_SOURCE', row.provider_id)
        : {
            state: 'KNOWN',
            value: money(row.discount_amount_minor, row.discount_currency),
            provenance,
          },
    eligibility: {
      minimumOrder:
        row.minimum_order_minor === null || row.minimum_order_currency === null
          ? unknown<Money>('NOT_PROVIDED_BY_SOURCE', row.provider_id)
          : {
              state: 'KNOWN',
              value: money(row.minimum_order_minor, row.minimum_order_currency),
              provenance,
            },
      productIds: row.eligible_product_ids ?? [],
      categoryPaths: Array.isArray(row.eligible_category_paths)
        ? (row.eligible_category_paths as string[][])
        : [],
      countries: row.eligible_countries ?? [],
      audience: row.audience as NormalizedCoupon['eligibility']['audience'],
      stackable:
        row.stackable === null
          ? unknown<boolean>('NOT_PROVIDED_BY_SOURCE', row.provider_id)
          : { state: 'KNOWN', value: row.stackable, provenance },
    },
    startsAt: row.starts_at?.toISOString() ?? null,
    expiresAt:
      row.expires_at === null
        ? unknown<string>('NOT_PROVIDED_BY_SOURCE', row.provider_id)
        : { state: 'KNOWN', value: row.expires_at.toISOString(), provenance },
    status: row.status as CouponStatus,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    verificationMethod: row.verification_method as NormalizedCoupon['verificationMethod'],
    sourceUrl: row.source_url,
  };

  // Recompute rather than trust the stored status.
  return { ...coupon, status: resolveStatus(coupon) };
}

function exactMoney(datum: NormalizedCoupon['discountAmount']): Money | null {
  return datum.state === 'KNOWN' ? datum.value : null;
}
