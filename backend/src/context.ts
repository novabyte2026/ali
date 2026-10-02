import { type Locale, type SourceMode } from '@shelf/shared';
import { type RegistryEntry, buildAdapterRegistry } from '@shelf/integrations';
import type { AppConfig } from './config/index.js';
import { type Logger, createLogger } from './logger.js';
import { type Database, createDatabase } from './db/pool.js';
import { type Cache, createCache } from './cache/index.js';
import { PolicyRegistry } from './compliance/policy-registry.js';
import { ComplianceGuardFactory } from './compliance/guard.js';
import { type SessionService, createSessionService } from './auth/session.js';
import { type GoogleAuthService, createGoogleAuthService } from './auth/google.js';
import { type CurrencyConverter, createCurrencyConverter } from './pricing/currency.js';
import { type CouponStore, createCouponStore } from './coupons/store.js';
import { type ProviderHealthTracker, createHealthTracker } from './providers/health.js';
import { type TelemetryService, createTelemetryService } from './analytics/telemetry.js';
import { type UserStore, createUserStore } from './users/store.js';
import { type AffiliateService, createAffiliateService } from './affiliate/service.js';
import type { AggregatorDeps } from './search/aggregator.js';

/**
 * Application context.
 *
 * Built once at boot and handed to route modules. Dependencies are passed in
 * rather than imported as singletons, so a test can construct a context with a
 * fake database or a stub adapter registry without touching module state.
 */

export interface AppContext {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly db: Database;
  readonly cache: Cache;
  readonly registry: ReadonlyArray<RegistryEntry>;
  readonly policies: PolicyRegistry;
  readonly guards: ComplianceGuardFactory;
  readonly sessions: SessionService;
  readonly google: GoogleAuthService;
  readonly converter: CurrencyConverter;
  readonly coupons: CouponStore;
  readonly health: ProviderHealthTracker;
  readonly telemetry: TelemetryService;
  readonly userStore: UserStore;
  readonly affiliate: AffiliateService;
  readonly aggregatorDeps: AggregatorDeps;
  readonly defaults: {
    readonly countryCode: string;
    readonly currency: string;
    readonly locale: Locale;
    readonly sourceMode: SourceMode;
  };
  searchExamples(locale: string): ReadonlyArray<{ readonly text: string; readonly query: string }>;
  shutdown(): Promise<void>;
}

export function createContext(config: AppConfig): AppContext {
  const log = createLogger(config.logLevel, { service: 'shelf-backend' });
  const db = createDatabase(config, log);
  const cache = createCache(config, log);

  const registry = buildAdapterRegistry(config.integrations);

  // The policy registry needs to know which capabilities have credentials, and
  // only the adapter knows that. Wiring it through here keeps policy and
  // configuration as separate concerns that are combined in one place.
  const policies = new PolicyRegistry(db, log, (providerId) => {
    const entry = registry.find((candidate) => candidate.providerId === providerId);
    return entry?.adapter.configuredCapabilities();
  });

  const guards = new ComplianceGuardFactory(policies, db, log);
  const sessions = createSessionService(db, config, log);
  const google = createGoogleAuthService(db, config, log);
  const converter = createCurrencyConverter(db, config, log);
  const coupons = createCouponStore(db, log);
  const health = createHealthTracker(db, config, log);
  const telemetry = createTelemetryService(db, config, log);
  const userStore = createUserStore(db, config, log);
  const affiliate = createAffiliateService(db, registry, guards, log);

  const aggregatorDeps: AggregatorDeps = {
    config,
    log,
    cache,
    guards,
    converter,
    registry,
    health,
    coupons,
  };

  return {
    config,
    log,
    db,
    cache,
    registry,
    policies,
    guards,
    sessions,
    google,
    converter,
    coupons,
    health,
    telemetry,
    userStore,
    affiliate,
    aggregatorDeps,
    defaults: {
      countryCode: 'IL',
      currency: 'ILS',
      locale: 'he',
      sourceMode: 'all',
    },
    searchExamples,
    async shutdown() {
      await Promise.allSettled([cache.close(), db.close()]);
    },
  };
}

/**
 * Example searches for the home page.
 *
 * Deliberately ordinary things people buy, written the way they would type
 * them, with real budgets. They exist to show that natural language works —
 * a budget, a brand, a use case — rather than to advertise categories.
 */
function searchExamples(
  locale: string,
): ReadonlyArray<{ readonly text: string; readonly query: string }> {
  if (locale === 'he') {
    return [
      { text: 'אוזניות עד 120 ₪', query: 'אוזניות עד 120 ₪' },
      { text: 'מטען USB-C עד 80 ₪', query: 'מטען USB-C עד 80 ₪' },
      { text: 'מקלדת מכנית עד 250 ₪', query: 'מקלדת מכנית עד 250 ₪' },
      { text: 'מצלמת רכב טובה', query: 'מצלמת רכב' },
      { text: 'שואב אבק קטן לדירה', query: 'שואב אבק קטן' },
      { text: 'סוללה ניידת 20000mAh', query: 'סוללה ניידת 20000mAh' },
    ];
  }
  return [
    { text: 'Headphones up to $40', query: 'headphones up to $40' },
    { text: 'USB-C charger 65W', query: 'USB-C charger 65W' },
    { text: 'Mechanical keyboard under $80', query: 'mechanical keyboard under $80' },
    { text: 'Dash cam for a car', query: 'dash cam' },
    { text: 'Small vacuum for a flat', query: 'small vacuum cleaner' },
    { text: 'Power bank 20000mAh', query: 'power bank 20000mAh' },
  ];
}
