import type { FastifyInstance } from 'fastify';
import { AppError } from '@shelf/shared';
import type { AppContext } from '../context.js';
import { deviceTypeOf, requirePermission } from '../middleware/index.js';

/**
 * Outbound link routes.
 *
 * The flow is deliberately two-step and transparent:
 *
 *   POST /affiliate/link   returns the destination, the tracking URL, the
 *                          destination host and the disclosure text.
 *   POST /affiliate/click  records the click and returns the URL to navigate.
 *
 * There is no redirect endpoint that hides the destination. The host is in the
 * payload, the UI shows it on the button, and the navigation is a normal link
 * the user can inspect. Cloaking is not implemented, and no provider policy in
 * the registry permits it.
 */

export async function registerAffiliateRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post(
    '/api/v1/affiliate/link',
    { preHandler: [requirePermission('product:view')] },
    async (request) => {
      const body = request.body as {
        providerId?: string;
        providerProductId?: string;
        destinationUrl?: string;
        placement?: string;
        locale?: string;
        country?: string;
      };

      if (!body.providerId || !body.providerProductId || !body.destinationUrl) {
        throw new AppError('ERROR_VALIDATION', {
          details: { required: ['providerId', 'providerProductId', 'destinationUrl'] },
        });
      }

      const link = await ctx.affiliate.buildLink({
        providerId: body.providerId,
        providerProductId: body.providerProductId,
        destinationUrl: body.destinationUrl,
        placement: (body.placement as never) ?? 'SEARCH_RESULT',
        locale: body.locale ?? request.profile?.preferences.locale ?? ctx.defaults.locale,
        countryCode: (
          body.country ??
          request.profile?.preferences.countryCode ??
          ctx.defaults.countryCode
        ).toUpperCase(),
        requestId: request.requestId,
      });

      return {
        link: {
          providerId: link.providerId,
          // Both URLs are returned. The user is told where they are going and
          // the tracked URL is visible, not concealed behind a redirect.
          destinationUrl: link.destinationUrl,
          affiliateUrl: link.affiliateUrl,
          destinationHost: link.destinationHost,
          status: link.status,
          placement: link.placement,
          disclosureRequired: link.disclosureRequired,
          disclosureKey: link.disclosureKey,
          disclosureText: link.disclosureText,
        },
        // Honest about whether this click can earn anything, which is also
        // what the admin console reports on.
        tracked: link.status === 'OK',
      };
    },
  );

  app.post(
    '/api/v1/affiliate/click',
    { preHandler: [requirePermission('product:view')] },
    async (request) => {
      const body = request.body as {
        providerId?: string;
        providerProductId?: string;
        destinationUrl?: string;
        productGroupId?: string;
        placement?: string;
        locale?: string;
        country?: string;
      };

      if (!body.providerId || !body.providerProductId || !body.destinationUrl) {
        throw new AppError('ERROR_VALIDATION', {
          details: { required: ['providerId', 'providerProductId', 'destinationUrl'] },
        });
      }

      const countryCode = (
        body.country ??
        request.profile?.preferences.countryCode ??
        ctx.defaults.countryCode
      ).toUpperCase();

      const link = await ctx.affiliate.buildLink({
        providerId: body.providerId,
        providerProductId: body.providerProductId,
        destinationUrl: body.destinationUrl,
        placement: (body.placement as never) ?? 'SEARCH_RESULT',
        locale: body.locale ?? request.profile?.preferences.locale ?? ctx.defaults.locale,
        countryCode,
        requestId: request.requestId,
      });

      const clickId = await ctx.affiliate.recordClick({
        link,
        principal: request.principal,
        productGroupId: body.productGroupId ?? null,
        providerProductId: body.providerProductId,
        countryCode,
        deviceType: deviceTypeOf(request),
      });

      void ctx.telemetry.recordEvent({
        type: 'affiliate_link_opened',
        sessionHash:
          request.principal.kind === 'user'
            ? `user:${request.principal.userId}`
            : request.principal.sessionHash,
        userId:
          request.principal.kind === 'user' && request.profile?.privacy.productAnalytics
            ? request.principal.userId
            : null,
        providerId: body.providerId,
        countryCode,
        deviceType: deviceTypeOf(request),
        properties: { placement: link.placement },
      });

      return {
        clickId,
        navigateTo: link.affiliateUrl,
        destinationHost: link.destinationHost,
        tracked: link.status === 'OK',
      };
    },
  );

  /** Site-wide explanation of how the product makes money (rules 42, 43). */
  app.get('/api/v1/affiliate/transparency', async (request) => {
    const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;
    const resolved = await ctx.policies.all();

    return {
      locale,
      // Translation keys; the copy lives in the frontend dictionary so it is
      // localized and reviewable alongside the rest of the interface.
      summaryKey: 'transparency.summary',
      pointKeys: [
        'transparency.commission',
        'transparency.priceUnaffected',
        'transparency.rankingNotPaid',
        'transparency.dataFromThirdParties',
        'transparency.priceSetByStore',
      ],
      programmes: resolved
        .filter((entry) => entry.providerEnabled)
        .map((entry) => ({
          providerId: entry.providerId,
          programmeName: entry.policy.programmeName,
          termsUrl: entry.policy.termsUrl,
          disclosure: entry.policy.requiredDisclosures[locale] ?? entry.policy.requiredDisclosures.en ?? null,
        })),
    };
  });
}
