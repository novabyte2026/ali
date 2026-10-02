import type { FastifyInstance } from 'fastify';
import { AppError, isSourceMode, money, newId } from '@shelf/shared';
import type { AppContext } from '../context.js';
import { requirePermission, requireUser, userIdOf } from '../middleware/index.js';

/**
 * Deal and Deal Radar routes.
 *
 * The notable behaviour is at radar creation: a subscription scoped to
 * providers that cannot support deal discovery is refused with the reason,
 * rather than created and left to never fire (rule 41). A control that quietly
 * does nothing is worse than one that is absent.
 */

export async function registerDealRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v1/deals',
    { preHandler: [requirePermission('deal:view_public')] },
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
      const limit = Math.min(Number.parseInt(query.limit ?? '30', 10) || 30, 60);
      const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;

      const allProviderIds = await ctx.policies.providerIds();
      const targetIds = mode === 'all' ? allProviderIds : allProviderIds.filter((id) => id === mode);

      // Report availability per source, so a thin feed is explained.
      const sourceStates: Array<{
        providerId: string;
        available: boolean;
        reasonKey: string | null;
      }> = [];

      const usableProviderIds: string[] = [];
      for (const providerId of targetIds) {
        const guard = await ctx.guards.forProvider(providerId, locale);
        const verdict = guard.check('deals');
        sourceStates.push({
          providerId,
          available: verdict.allowed,
          reasonKey: verdict.allowed ? null : `capability.deals.${verdict.state}`,
        });
        if (verdict.allowed) usableProviderIds.push(providerId);
      }

      if (usableProviderIds.length === 0) {
        return { deals: [], sources: sourceStates, countryCode, mode };
      }

      const result = await ctx.db.query<DealRow>(
        `SELECT deal_id, provider_id, product_group_id, provider_product_id,
                country_code, evidence, strength, band, coupon_id, ends_at,
                first_seen_at, last_confirmed_at, data_origin
           FROM deal_events
          WHERE retired_at IS NULL
            AND country_code = $1
            AND provider_id = ANY($2)
          ORDER BY strength DESC, last_confirmed_at DESC
          LIMIT $3`,
        [countryCode, usableProviderIds, limit],
      );

      return {
        mode,
        countryCode,
        sources: sourceStates,
        deals: result.rows.map((row) => ({
          dealId: row.deal_id,
          providerId: row.provider_id,
          productGroupId: row.product_group_id,
          providerProductId: row.provider_product_id,
          evidence: row.evidence,
          strength: Number.parseFloat(row.strength),
          band: row.band,
          // Null means no countdown is rendered at all. We do not invent one.
          endsAt: row.ends_at?.toISOString() ?? null,
          firstSeenAt: row.first_seen_at.toISOString(),
          lastConfirmedAt: row.last_confirmed_at.toISOString(),
          containsDemoData: row.data_origin === 'DEMO_FIXTURE',
        })),
      };
    },
  );

  app.get(
    '/api/v1/deals/radars',
    { preHandler: [requireUser, requirePermission('deal:radar')] },
    async (request) => {
      const result = await ctx.db.query<RadarRow>(
        `SELECT radar_id, label, category_path, keywords, provider_ids,
                budget_max_minor, budget_currency, min_rating, min_strength,
                country_code, require_verified_coupon, active, created_at, last_scanned_at
           FROM deal_radar_subscriptions
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userIdOf(request)],
      );
      return { radars: result.rows.map(toRadar) };
    },
  );

  app.post(
    '/api/v1/deals/radars',
    { preHandler: [requireUser, requirePermission('deal:radar')] },
    async (request) => {
      const body = request.body as {
        label?: string;
        keywords?: string;
        categoryPath?: string[];
        providerIds?: string[];
        budgetMax?: number;
        currency?: string;
        minRating?: number;
        minStrength?: number;
        requireVerifiedCoupon?: boolean;
        country?: string;
      };

      if (!body.label || body.label.trim().length === 0) {
        throw new AppError('ERROR_VALIDATION', { details: { field: 'label' } });
      }

      const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;
      const requested =
        body.providerIds && body.providerIds.length > 0
          ? body.providerIds
          : await ctx.policies.providerIds();

      // Capability gate at creation time, with the reason returned.
      const supported: string[] = [];
      const rejected: Array<{ providerId: string; reasonKey: string }> = [];

      for (const providerId of requested) {
        const verdict = await ctx.guards.featureVerdict('dealRadar', providerId).catch(() => null);
        if (verdict?.enabled) {
          supported.push(providerId);
        } else {
          const blocker = verdict?.blockedBy[0];
          rejected.push({
            providerId,
            reasonKey: blocker
              ? `capability.${blocker.capability}.${blocker.state}`
              : 'capability.deals.NOT_PERMITTED',
          });
        }
      }

      if (supported.length === 0) {
        // Refused rather than created-and-silent.
        throw new AppError('ERROR_CAPABILITY_UNAVAILABLE', {
          details: {
            feature: 'dealRadar',
            rejected: rejected.map((entry) => `${entry.providerId}:${entry.reasonKey}`),
          },
        });
      }

      const countryCode = (
        body.country ??
        request.profile?.preferences.countryCode ??
        ctx.defaults.countryCode
      ).toUpperCase();
      const currency = (
        body.currency ??
        request.profile?.preferences.currency ??
        ctx.defaults.currency
      ).toUpperCase();

      const budget =
        typeof body.budgetMax === 'number' && body.budgetMax > 0
          ? money(Math.round(body.budgetMax * 100), currency)
          : null;

      const result = await ctx.db.query<RadarRow>(
        `INSERT INTO deal_radar_subscriptions
           (radar_id, user_id, label, category_path, keywords, provider_ids,
            budget_max_minor, budget_currency, min_rating, min_strength,
            country_code, require_verified_coupon)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING radar_id, label, category_path, keywords, provider_ids,
                   budget_max_minor, budget_currency, min_rating, min_strength,
                   country_code, require_verified_coupon, active, created_at, last_scanned_at`,
        [
          newId('rad'),
          userIdOf(request),
          body.label.trim().slice(0, 120),
          body.categoryPath ?? null,
          body.keywords?.slice(0, 200) ?? null,
          supported,
          budget?.minor ?? null,
          budget?.currency ?? null,
          body.minRating ?? null,
          Math.min(Math.max(body.minStrength ?? 0.5, 0), 1),
          countryCode,
          body.requireVerifiedCoupon ?? false,
        ],
      );

      const row = result.rows[0];
      if (!row) throw new AppError('ERROR_INTERNAL');

      return {
        radar: toRadar(row),
        // Honest about which sources this radar will not cover and why.
        excludedProviders: rejected,
      };
    },
  );

  app.delete(
    '/api/v1/deals/radars/:radarId',
    { preHandler: [requireUser, requirePermission('deal:radar')] },
    async (request) => {
      const { radarId } = request.params as { radarId: string };
      const result = await ctx.db.query(
        'DELETE FROM deal_radar_subscriptions WHERE radar_id = $1 AND user_id = $2',
        [radarId, userIdOf(request)],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'radar' } });
      }
      return { deleted: true };
    },
  );
}

interface DealRow {
  deal_id: string;
  provider_id: string;
  product_group_id: string | null;
  provider_product_id: string;
  country_code: string;
  evidence: unknown;
  strength: string;
  band: string;
  coupon_id: string | null;
  ends_at: Date | null;
  first_seen_at: Date;
  last_confirmed_at: Date;
  data_origin: string;
}

interface RadarRow {
  radar_id: string;
  label: string;
  category_path: string[] | null;
  keywords: string | null;
  provider_ids: string[];
  budget_max_minor: number | null;
  budget_currency: string | null;
  min_rating: string | null;
  min_strength: string;
  country_code: string;
  require_verified_coupon: boolean;
  active: boolean;
  created_at: Date;
  last_scanned_at: Date | null;
}

function toRadar(row: RadarRow) {
  return {
    radarId: row.radar_id,
    label: row.label,
    categoryPath: row.category_path,
    keywords: row.keywords,
    providerIds: row.provider_ids,
    budgetMax:
      row.budget_max_minor !== null && row.budget_currency !== null
        ? money(row.budget_max_minor, row.budget_currency)
        : null,
    minRating: row.min_rating === null ? null : Number.parseFloat(row.min_rating),
    minStrength: Number.parseFloat(row.min_strength),
    countryCode: row.country_code,
    requireVerifiedCoupon: row.require_verified_coupon,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    lastScannedAt: row.last_scanned_at?.toISOString() ?? null,
  };
}
