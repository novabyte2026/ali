import type { FastifyInstance } from 'fastify';
import {
  type AlertKind,
  ALERT_CAPABILITY_REQUIREMENTS,
  ALERT_KINDS,
  AppError,
  isCapability,
  money,
} from '@shelf/shared';
import type { AppContext } from '../context.js';
import { requirePermission, requireUser, userIdOf } from '../middleware/index.js';
import { createCartService } from '../cart/service.js';

/**
 * Account routes: favourites, saved searches, alerts, cart, preferences,
 * export and deletion.
 *
 * Every route here is behind `requireUser` plus a permission check, so these
 * are the endpoints a guest is genuinely blocked from — not merely the ones
 * whose buttons the frontend hides (rules 34, 83, 84). The E2E suite calls
 * them directly as a guest to prove it.
 */

export async function registerUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const carts = createCartService(ctx.db, ctx.converter, ctx.log);

  // --- Profile and preferences -------------------------------------------

  app.get('/api/v1/me/profile', { preHandler: [requireUser] }, async (request) => ({
    profile: await ctx.userStore.profile(userIdOf(request)),
  }));

  app.patch(
    '/api/v1/me/preferences',
    { preHandler: [requireUser, requirePermission('preferences:manage')] },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const profile = await ctx.userStore.updatePreferences(userIdOf(request), {
        ...(body.locale === 'he' || body.locale === 'en' ? { locale: body.locale } : {}),
        ...(typeof body.countryCode === 'string' ? { countryCode: body.countryCode } : {}),
        ...(typeof body.currency === 'string' ? { currency: body.currency } : {}),
        ...(typeof body.defaultSourceMode === 'string'
          ? { defaultSourceMode: body.defaultSourceMode }
          : {}),
        ...(typeof body.defaultSort === 'string' ? { defaultSort: body.defaultSort } : {}),
        ...(typeof body.reducedMotion === 'boolean' ? { reducedMotion: body.reducedMotion } : {}),
        ...(typeof body.emailAlerts === 'boolean' ? { emailAlerts: body.emailAlerts } : {}),
        ...(typeof body.inAppAlerts === 'boolean' ? { inAppAlerts: body.inAppAlerts } : {}),
        ...(body.dealDigest === 'OFF' || body.dealDigest === 'DAILY' || body.dealDigest === 'WEEKLY'
          ? { dealDigest: body.dealDigest }
          : {}),
      });
      return { profile };
    },
  );

  app.patch(
    '/api/v1/me/privacy',
    { preHandler: [requireUser, requirePermission('preferences:manage')] },
    async (request) => {
      const body = request.body as Record<string, unknown>;
      const profile = await ctx.userStore.updatePrivacy(userIdOf(request), {
        ...(typeof body.storeSearchHistory === 'boolean'
          ? { storeSearchHistory: body.storeSearchHistory }
          : {}),
        ...(typeof body.personalizedRanking === 'boolean'
          ? { personalizedRanking: body.personalizedRanking }
          : {}),
        ...(typeof body.productAnalytics === 'boolean'
          ? { productAnalytics: body.productAnalytics }
          : {}),
        ...(typeof body.marketingEmails === 'boolean'
          ? { marketingEmails: body.marketingEmails }
          : {}),
      });
      return { profile };
    },
  );

  // --- Favourites ---------------------------------------------------------

  app.get(
    '/api/v1/me/favorites',
    { preHandler: [requireUser, requirePermission('favorites:manage')] },
    async (request) => ({ favorites: await ctx.userStore.favorites(userIdOf(request)) }),
  );

  app.post(
    '/api/v1/me/favorites',
    { preHandler: [requireUser, requirePermission('favorites:manage')] },
    async (request) => {
      const body = request.body as {
        providerId?: string;
        providerProductId?: string;
        productGroupId?: string;
        note?: string;
      };
      if (!body.providerId || !body.providerProductId) {
        throw new AppError('ERROR_VALIDATION', {
          details: { required: ['providerId', 'providerProductId'] },
        });
      }
      return {
        favorite: await ctx.userStore.addFavorite({
          userId: userIdOf(request),
          providerId: body.providerId,
          providerProductId: body.providerProductId,
          productGroupId: body.productGroupId ?? null,
          note: body.note ?? null,
        }),
      };
    },
  );

  app.delete(
    '/api/v1/me/favorites/:favoriteId',
    { preHandler: [requireUser, requirePermission('favorites:manage')] },
    async (request) => {
      const { favoriteId } = request.params as { favoriteId: string };
      await ctx.userStore.removeFavorite(userIdOf(request), favoriteId);
      return { deleted: true };
    },
  );

  // --- Saved searches -----------------------------------------------------

  app.get(
    '/api/v1/me/saved-searches',
    { preHandler: [requireUser, requirePermission('saved_search:manage')] },
    async (request) => ({ savedSearches: await ctx.userStore.savedSearches(userIdOf(request)) }),
  );

  app.post(
    '/api/v1/me/saved-searches',
    { preHandler: [requireUser, requirePermission('saved_search:manage')] },
    async (request) => {
      const body = request.body as {
        label?: string;
        query?: string;
        mode?: string;
        filters?: Record<string, unknown>;
        sort?: string;
        notifyOnNewResults?: boolean;
      };
      if (!body.query) throw new AppError('ERROR_VALIDATION', { details: { field: 'query' } });

      const profile = request.profile;
      return {
        savedSearch: await ctx.userStore.saveSearch({
          userId: userIdOf(request),
          label: body.label ?? body.query,
          query: body.query,
          mode: body.mode ?? 'all',
          filters: body.filters ?? {},
          sort: body.sort ?? 'MOST_RELEVANT',
          countryCode: profile?.preferences.countryCode ?? ctx.defaults.countryCode,
          currency: profile?.preferences.currency ?? ctx.defaults.currency,
          notifyOnNewResults: body.notifyOnNewResults ?? false,
        }),
      };
    },
  );

  app.delete(
    '/api/v1/me/saved-searches/:savedSearchId',
    { preHandler: [requireUser, requirePermission('saved_search:manage')] },
    async (request) => {
      const { savedSearchId } = request.params as { savedSearchId: string };
      await ctx.userStore.deleteSavedSearch(userIdOf(request), savedSearchId);
      return { deleted: true };
    },
  );

  // --- Alerts -------------------------------------------------------------

  app.get(
    '/api/v1/me/alerts',
    { preHandler: [requireUser, requirePermission('alert:manage')] },
    async (request) => ({ alerts: await ctx.userStore.alerts(userIdOf(request)) }),
  );

  /**
   * Alert creation is the clearest place where the capability model becomes
   * visible to a user. A price alert on an Amazon product is refused, with the
   * reason, because that programme's retention limits make a price series
   * impossible — and the alternative, creating a subscription that silently
   * never fires, is worse (rules 23, 41).
   */
  app.post(
    '/api/v1/me/alerts',
    { preHandler: [requireUser, requirePermission('alert:manage')] },
    async (request) => {
      const body = request.body as {
        kind?: string;
        providerId?: string;
        productGroupId?: string;
        providerProductId?: string;
        providerVariantId?: string;
        targetPrice?: number;
        thresholdPercent?: number;
        channels?: string[];
      };

      if (!body.kind || !(ALERT_KINDS as readonly string[]).includes(body.kind)) {
        throw new AppError('ERROR_VALIDATION', {
          details: { field: 'kind', allowed: [...ALERT_KINDS] },
        });
      }
      const kind = body.kind as AlertKind;

      if (!body.providerId) {
        throw new AppError('ERROR_VALIDATION', { details: { field: 'providerId' } });
      }

      const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;
      const guard = await ctx.guards.forProvider(body.providerId, locale);

      const required = ALERT_CAPABILITY_REQUIREMENTS[kind];
      const blocked = required
        .filter(isCapability)
        .map((capability) => ({ capability, verdict: guard.check(capability) }))
        .filter((entry) => !entry.verdict.allowed);

      if (blocked.length > 0) {
        const first = blocked[0];
        throw new AppError('ERROR_CAPABILITY_UNAVAILABLE', {
          details: {
            kind,
            providerId: body.providerId,
            capability: first?.capability ?? null,
            state: first?.verdict.state ?? null,
            // The key the UI turns into plain language, without quoting
            // policy text at a shopper (rule 41).
            messageKey: `capability.${first?.capability}.${first?.verdict.state}`,
          },
        });
      }

      const profile = request.profile;
      const currency = profile?.preferences.currency ?? ctx.defaults.currency;

      if (kind === 'TARGET_PRICE' && (body.targetPrice === undefined || body.targetPrice <= 0)) {
        throw new AppError('ERROR_VALIDATION', { details: { field: 'targetPrice' } });
      }

      const channels = (body.channels ?? ['IN_APP']).filter(
        (channel): channel is 'EMAIL' | 'IN_APP' => channel === 'EMAIL' || channel === 'IN_APP',
      );

      return {
        alert: await ctx.userStore.createAlert({
          userId: userIdOf(request),
          kind,
          providerId: body.providerId,
          productGroupId: body.productGroupId ?? null,
          providerProductId: body.providerProductId ?? null,
          providerVariantId: body.providerVariantId ?? null,
          countryCode: profile?.preferences.countryCode ?? ctx.defaults.countryCode,
          targetPrice:
            body.targetPrice === undefined
              ? null
              : money(Math.round(body.targetPrice * 100), currency),
          thresholdPercent: body.thresholdPercent ?? null,
          channels: channels.length > 0 ? channels : ['IN_APP'],
        }),
      };
    },
  );

  app.delete(
    '/api/v1/me/alerts/:alertId',
    { preHandler: [requireUser, requirePermission('alert:manage')] },
    async (request) => {
      const { alertId } = request.params as { alertId: string };
      await ctx.userStore.deleteAlert(userIdOf(request), alertId);
      return { deleted: true };
    },
  );

  // --- Smart Cart ---------------------------------------------------------

  app.get(
    '/api/v1/me/carts',
    { preHandler: [requireUser, requirePermission('cart:manage')] },
    async (request) => ({ carts: await carts.list(userIdOf(request)) }),
  );

  app.post(
    '/api/v1/me/carts',
    { preHandler: [requireUser, requirePermission('cart:manage')] },
    async (request) => {
      const body = request.body as { label?: string };
      const profile = request.profile;
      return carts.create({
        userId: userIdOf(request),
        label: body.label ?? 'My comparison',
        currency: profile?.preferences.currency ?? ctx.defaults.currency,
        countryCode: profile?.preferences.countryCode ?? ctx.defaults.countryCode,
      });
    },
  );

  app.get(
    '/api/v1/me/carts/:cartId',
    { preHandler: [requireUser, requirePermission('cart:manage')] },
    async (request) => {
      const { cartId } = request.params as { cartId: string };
      const currency =
        (request.query as { currency?: string }).currency ??
        request.profile?.preferences.currency ??
        ctx.defaults.currency;
      return { cart: await carts.get(userIdOf(request), cartId, currency) };
    },
  );

  app.post(
    '/api/v1/me/carts/:cartId/lines',
    { preHandler: [requireUser, requirePermission('cart:manage')] },
    async (request) => {
      const { cartId } = request.params as { cartId: string };
      const body = request.body as {
        providerId?: string;
        providerProductId?: string;
        providerVariantId?: string;
        title?: string;
        imageUrl?: string;
        quantity?: number;
        offer?: unknown;
      };

      if (!body.providerId || !body.providerProductId || !body.title || !body.offer) {
        throw new AppError('ERROR_VALIDATION', {
          details: { required: ['providerId', 'providerProductId', 'title', 'offer'] },
        });
      }

      await carts.addLine({
        userId: userIdOf(request),
        cartId,
        providerId: body.providerId,
        providerProductId: body.providerProductId,
        providerVariantId: body.providerVariantId ?? null,
        title: body.title,
        imageUrl: body.imageUrl ?? null,
        quantity: body.quantity ?? 1,
        offer: body.offer as never,
      });

      return { added: true };
    },
  );

  app.patch(
    '/api/v1/me/carts/:cartId/lines/:lineId',
    { preHandler: [requireUser, requirePermission('cart:manage')] },
    async (request) => {
      const { cartId, lineId } = request.params as { cartId: string; lineId: string };
      const body = request.body as { quantity?: number };
      if (typeof body.quantity !== 'number') {
        throw new AppError('ERROR_VALIDATION', { details: { field: 'quantity' } });
      }
      await carts.updateQuantity({
        userId: userIdOf(request),
        cartId,
        lineId,
        quantity: body.quantity,
      });
      return { updated: true };
    },
  );

  app.delete(
    '/api/v1/me/carts/:cartId/lines/:lineId',
    { preHandler: [requireUser, requirePermission('cart:manage')] },
    async (request) => {
      const { cartId, lineId } = request.params as { cartId: string; lineId: string };
      await carts.removeLine(userIdOf(request), cartId, lineId);
      return { deleted: true };
    },
  );

  app.delete(
    '/api/v1/me/carts/:cartId',
    { preHandler: [requireUser, requirePermission('cart:manage')] },
    async (request) => {
      const { cartId } = request.params as { cartId: string };
      await carts.deleteCart(userIdOf(request), cartId);
      return { deleted: true };
    },
  );

  // --- History ------------------------------------------------------------

  app.get(
    '/api/v1/me/history',
    { preHandler: [requireUser, requirePermission('history:view')] },
    async (request) => {
      const profile = request.profile;
      if (!profile?.privacy.storeSearchHistory) {
        // Off is the default, and the response says so rather than returning
        // an empty list that looks like "you have never searched".
        return { enabled: false, history: [] };
      }
      return {
        enabled: true,
        history: await ctx.userStore.searchHistory(userIdOf(request), 100),
      };
    },
  );

  app.delete(
    '/api/v1/me/history',
    { preHandler: [requireUser, requirePermission('history:view')] },
    async (request) => ({ deleted: await ctx.userStore.clearSearchHistory(userIdOf(request)) }),
  );

  // --- Data rights --------------------------------------------------------

  app.get(
    '/api/v1/me/export',
    { preHandler: [requireUser, requirePermission('preferences:manage')] },
    async (request, reply) => {
      const data = await ctx.userStore.exportAll(userIdOf(request));
      reply.header('content-disposition', 'attachment; filename="shelf-export.json"');
      reply.header('cache-control', 'no-store');
      return data;
    },
  );

  /**
   * Account deletion. Requires the user to type their own e-mail as
   * confirmation, which is checked server-side against the session's identity
   * — a client-side confirm dialog is not a safeguard.
   */
  app.post(
    '/api/v1/me/delete',
    { preHandler: [requireUser, requirePermission('account:delete')] },
    async (request, reply) => {
      const body = request.body as { confirmEmail?: string };
      if (request.principal.kind !== 'user') throw new AppError('ERROR_AUTH_REQUIRED');

      if (
        !body.confirmEmail ||
        body.confirmEmail.trim().toLowerCase() !== request.principal.email.toLowerCase()
      ) {
        throw new AppError('ERROR_VALIDATION', {
          details: { field: 'confirmEmail', reason: 'MUST_MATCH_ACCOUNT_EMAIL' },
        });
      }

      await ctx.userStore.deleteAccount(request.principal.userId);
      reply.clearCookie(ctx.config.session.cookieName, { path: '/' });
      return { deleted: true };
    },
  );
}
