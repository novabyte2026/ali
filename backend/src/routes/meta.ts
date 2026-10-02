import type { FastifyInstance } from 'fastify';
import {
  type ProviderDescriptor,
  COUNTRIES,
  FEATURE_NAMES,
  FEATURE_STATUS,
  SUPPORTED_CURRENCIES,
  SUPPORTED_LOCALES,
  capabilitySeverity,
  evaluateFeature,
} from '@shelf/shared';
import type { AppContext } from '../context.js';
import { loadProviderMarkets } from '../compliance/policy-registry.js';

/**
 * Metadata endpoints.
 *
 * These exist so the frontend never has to assume anything about what a
 * provider can do. It asks, and renders accordingly: a source whose coupon
 * capability is unavailable gets no coupon tab, and a price-alert button is
 * absent for a provider that cannot support one — with the reason available
 * so the UI can explain rather than just hide.
 *
 * `/meta/features` serves the production-readiness register, so the honest
 * state of every feature is a fact the product reports about itself rather
 * than something a reader has to infer.
 */

export async function registerMetaRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/providers', async (request) => {
    const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;
    const resolved = await ctx.policies.all();
    const markets = await loadProviderMarkets(ctx.db);
    const marketById = new Map(markets.map((market) => [market.providerId, market]));

    const descriptors: ProviderDescriptor[] = resolved.map((entry) => {
      const market = marketById.get(entry.providerId);
      const registryEntry = ctx.registry.find(
        (candidate) => candidate.providerId === entry.providerId,
      );

      return {
        id: entry.providerId,
        branding: {
          displayName: entry.policy.brandingRules.nameMustAppearAs,
          logoPermitted: entry.policy.brandingRules.logoUsePermitted,
          logoAssetPath: entry.policy.brandingRules.logoAssetPath,
          // Only shown where a programme requires specific wording.
          attributionNotice: entry.policy.requiredDisclosures[locale] ?? null,
        },
        countries: market?.countries ?? [],
        defaultCountry: market?.defaultCountry ?? ctx.defaults.countryCode,
        currencies: market?.currencies ?? [],
        capabilities: entry.effective,
        runtimeState: entry.providerEnabled
          ? entry.effective.search === 'AVAILABLE'
            ? (ctx.health.snapshot(entry.providerId)?.runtimeState ?? 'ACTIVE')
            : 'UNAVAILABLE'
          : entry.effective.search === 'NOT_CONFIGURED'
            ? 'NOT_CONFIGURED'
            : 'DISABLED_BY_OPERATOR',
        policyVersion: entry.policy.policyVersion,
        servingDemoFixtures: registryEntry?.servingDemoFixtures ?? false,
      };
    });

    return {
      providers: descriptors,
      // Which routes can actually answer right now. The header renders all
      // four regardless, but a route with no searchable source is shown as
      // unavailable rather than failing on click.
      searchableProviderIds: await ctx.policies.searchableProviderIds(),
      anyDemoFixtures: ctx.registry.some((entry) => entry.servingDemoFixtures),
    };
  });

  /**
   * Per-provider feature availability, with the blocking capability named.
   * This is what lets the UI say "price alerts are not available for this
   * source" instead of silently omitting a control.
   */
  app.get('/api/v1/providers/:providerId/features', async (request) => {
    const { providerId } = request.params as { providerId: string };
    const resolved = await ctx.policies.forProvider(providerId);

    return {
      providerId,
      policyVersion: resolved.policy.policyVersion,
      features: FEATURE_NAMES.map((feature) => {
        const verdict = evaluateFeature(feature, providerId, resolved.effective);
        return {
          feature,
          enabled: verdict.enabled,
          blockedBy: verdict.blockedBy.map((entry) => ({
            capability: entry.capability,
            state: entry.state,
            // A translation key, not prose: the UI explains in the user's
            // language and never shows a policy excerpt to a shopper.
            messageKey: `capability.${entry.capability}.${entry.state}`,
          })),
        };
      }),
    };
  });

  /** Disclosure text, per provider and locale, plus the central disclosure. */
  app.get('/api/v1/meta/disclosures', async (request) => {
    const locale =
      (request.query as { locale?: string }).locale ??
      request.profile?.preferences.locale ??
      ctx.defaults.locale;

    const resolved = await ctx.policies.all();

    return {
      locale,
      // The site-wide statement, always rendered in the footer.
      central: 'disclosure.central',
      providers: resolved.map((entry) => ({
        providerId: entry.providerId,
        text: entry.policy.requiredDisclosures[locale] ?? entry.policy.requiredDisclosures.en ?? null,
        placements: entry.policy.disclosurePlacements,
        programmeName: entry.policy.programmeName,
        termsUrl: entry.policy.termsUrl,
      })),
    };
  });

  /** Production-readiness register (rule 253). */
  app.get('/api/v1/meta/features', async () => ({
    features: FEATURE_STATUS,
    counts: {
      productionReady: FEATURE_STATUS.filter((f) => f.status === 'PRODUCTION_READY').length,
      partial: FEATURE_STATUS.filter((f) => f.status === 'PARTIAL').length,
      integrationPending: FEATURE_STATUS.filter((f) => f.status === 'INTEGRATION_PENDING').length,
      planned: FEATURE_STATUS.filter((f) => f.status === 'PLANNED').length,
    },
  }));

  app.get('/api/v1/meta/config', async () => ({
    locales: SUPPORTED_LOCALES,
    currencies: SUPPORTED_CURRENCIES,
    countries: COUNTRIES.map((country) => ({
      code: country.code,
      defaultCurrency: country.defaultCurrency,
      // Exposed so the UI can say a tax figure is an estimate from this rate.
      hasVatEstimate: country.vatRate !== null,
    })),
    defaults: ctx.defaults,
    demoFixturesActive: ctx.registry.some((entry) => entry.servingDemoFixtures),
  }));

  /**
   * Liveness and readiness.
   *
   * `/health` answers whether the process is up. `/ready` answers whether it
   * can serve: database reachable, at least one provider able to answer.
   * A load balancer wants the second one.
   */
  app.get('/health', async () => ({ status: 'ok', at: new Date().toISOString() }));

  app.get('/ready', async (_request, reply) => {
    const databaseHealthy = await ctx.db.healthy();
    const searchable = await ctx.policies.searchableProviderIds().catch(() => []);
    const ready = databaseHealthy && searchable.length > 0;

    if (!ready) reply.status(503);

    return {
      ready,
      database: databaseHealthy,
      searchableProviders: searchable.length,
      cache: ctx.cache.stats().driver,
    };
  });

  /**
   * Operational metrics in a plain JSON shape. Intentionally not Prometheus
   * text format: nothing here scrapes it yet, and a JSON body is easier to
   * read during an incident than an exposition format nobody has configured.
   */
  app.get('/api/v1/meta/metrics', async () => {
    const cache = ctx.cache.stats();
    const health = ctx.health.all();
    const resolved = await ctx.policies.all();

    return {
      cache,
      providers: health,
      compliance: {
        providersWithStalePolicy: resolved.filter((entry) => entry.policyStale).length,
        capabilitiesAwaitingVerification: resolved.reduce(
          (total, entry) =>
            total +
            Object.values(entry.effective).filter(
              (state) => capabilitySeverity(state) === 'ACTION_REQUIRED',
            ).length,
          0,
        ),
      },
      analytics: { droppedProperties: ctx.telemetry.droppedPropertyCount() },
    };
  });
}
