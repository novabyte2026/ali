import type { FastifyInstance } from 'fastify';
import { AppError, couponIsPresentable, isSourceMode } from '@shelf/shared';
import type { AppContext } from '../context.js';
import { requirePermission } from '../middleware/index.js';
import { couponTrustSummary } from '../coupons/engine.js';

/**
 * Coupon routes.
 *
 * The response shape is built so a client cannot render a coupon without its
 * verification state: `status`, `trust` and `lastCheckedAt` sit alongside the
 * code, and there is no field that says "active" as a bare boolean.
 *
 * A provider whose coupon capability is unavailable is reported as such rather
 * than returning an empty list, because an empty list reads as "this store has
 * no coupons" — a claim we have no basis for (rule 288).
 */

export async function registerCouponRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v1/coupons',
    { preHandler: [requirePermission('coupon:view_public')] },
    async (request) => {
      const query = request.query as { source?: string; country?: string; limit?: string };
      const mode = query.source ?? 'all';
      if (!isSourceMode(mode)) {
        throw new AppError('ERROR_UNSUPPORTED_SOURCE', { details: { mode } });
      }

      const countryCode = (
        query.country ??
        request.profile?.preferences.countryCode ??
        ctx.defaults.countryCode
      ).toUpperCase();
      const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;
      const limit = Math.min(Number.parseInt(query.limit ?? '40', 10) || 40, 100);

      const allProviderIds = await ctx.policies.providerIds();
      const targetIds =
        mode === 'all' ? allProviderIds : allProviderIds.filter((id) => id === mode);

      const sources: Array<{
        providerId: string;
        available: boolean;
        reasonKey: string | null;
        coupons: unknown[];
      }> = [];

      for (const providerId of targetIds) {
        const guard = await ctx.guards.forProvider(providerId, locale);
        const verdict = guard.check('coupons');

        if (!verdict.allowed) {
          sources.push({
            providerId,
            available: false,
            // Why there is nothing here, which is different from there being
            // nothing to find.
            reasonKey: `capability.coupons.${verdict.state}`,
            coupons: [],
          });
          continue;
        }

        const coupons = await ctx.coupons.activeForProvider(providerId, countryCode);
        sources.push({
          providerId,
          available: true,
          reasonKey: null,
          coupons: coupons
            .filter((coupon) => couponIsPresentable(coupon.status))
            .slice(0, limit)
            .map((coupon) => ({
              couponId: coupon.couponId,
              providerId: coupon.providerId,
              code: coupon.code,
              title: coupon.title,
              terms: coupon.terms,
              discountType: coupon.discountType,
              discountPercent: coupon.discountPercent,
              discountAmount: coupon.discountAmount,
              eligibility: coupon.eligibility,
              expiresAt: coupon.expiresAt,
              status: coupon.status,
              lastCheckedAt: coupon.lastCheckedAt,
              // Everything a user needs to judge whether to trust the code.
              trust: couponTrustSummary(coupon),
            })),
        });
      }

      return {
        mode,
        countryCode,
        sources,
        totalPresentable: sources.reduce((total, source) => total + source.coupons.length, 0),
        anySourceUnavailable: sources.some((source) => !source.available),
      };
    },
  );

  app.get(
    '/api/v1/coupons/:providerId/:providerProductId',
    { preHandler: [requirePermission('coupon:view_public')] },
    async (request) => {
      const { providerId, providerProductId } = request.params as {
        providerId: string;
        providerProductId: string;
      };
      const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;
      const countryCode = (
        (request.query as { country?: string }).country ??
        request.profile?.preferences.countryCode ??
        ctx.defaults.countryCode
      ).toUpperCase();

      const guard = await ctx.guards.forProvider(providerId, locale);
      const verdict = guard.check('coupons');

      if (!verdict.allowed) {
        return {
          available: false,
          reasonKey: `capability.coupons.${verdict.state}`,
          coupons: [],
        };
      }

      const coupons = await ctx.coupons.forProduct(providerId, providerProductId, countryCode);

      return {
        available: true,
        reasonKey: null,
        coupons: coupons
          .filter((coupon) => couponIsPresentable(coupon.status))
          .map((coupon) => ({ ...coupon, trust: couponTrustSummary(coupon) })),
      };
    },
  );
}
