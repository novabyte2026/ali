/**
 * Library entry point.
 *
 * Exports the reusable pieces of the backend without any side effects, so the
 * worker process and the test suite can build a context, a database pool or a
 * compliance guard without starting an HTTP listener. `server.ts` is the only
 * module that binds a port, and nothing imports it.
 */

export { loadConfig, describeConfig, type AppConfig } from './config/index.js';
export { createContext, type AppContext } from './context.js';
export { buildApp } from './app.js';
export { createLogger, type Logger, type LogLevel } from './logger.js';
export { createDatabase, firstRow, requireRow, type Database, type Db } from './db/pool.js';
export { createCache, createMemoryCache, type Cache, type CacheStats } from './cache/index.js';

export { PolicyRegistry, narrowMatrix, loadProviderMarkets } from './compliance/policy-registry.js';
export type { ResolvedProviderPolicy } from './compliance/policy-registry.js';
export { ComplianceGuardFactory, ProviderGuard } from './compliance/guard.js';

export { parseQuery, intentToFilters, vatRateFor } from './search/parser.js';
export { aggregateSearch, type AggregatorDeps } from './search/aggregator.js';
export { applyHardFilters, rankGroups, type RankingContext } from './search/ranking.js';

export {
  ENGINE_VERSION,
  compareVariants,
  explainMatch,
  identityKey,
  matchProducts,
  satisfiesSameProductRequest,
} from './matching/engine.js';

export { groupListings, groupMatchLevel, pickPrimaryProvider } from './products/grouping.js';
export { budgetRelation, compareOffers, estimateTax, priceOffer } from './pricing/engine.js';
export { createCurrencyConverter, type CurrencyConverter } from './pricing/currency.js';

export {
  applyCouponToOffer,
  couponTrustSummary,
  resolveStatus,
  selectCouponsForOffer,
  withResolvedStatus,
} from './coupons/engine.js';
export { createCouponStore, type CouponStore } from './coupons/store.js';
export { huntDeals, totalSaving, type HuntInput } from './deals/hunter.js';

export { createSessionService, type SessionService } from './auth/session.js';
export { createGoogleAuthService, type GoogleAuthService } from './auth/google.js';
export { createUserStore, type UserStore } from './users/store.js';
export { createCartService, type CartService } from './cart/service.js';
export { createAffiliateService, type AffiliateService } from './affiliate/service.js';
export { createHealthTracker, type ProviderHealthTracker } from './providers/health.js';
export { createTelemetryService, type TelemetryService } from './analytics/telemetry.js';
