import type { FastifyInstance } from 'fastify';
import {
  type SearchFilters,
  type SearchRequest,
  type SearchStreamEvent,
  type SortOption,
  AppError,
  SORT_OPTIONS,
  isSourceMode,
  isSupportedCountry,
  isSupportedCurrency,
  moneyFromDecimal,
  newId,
} from '@shelf/shared';
import type { AppContext } from '../context.js';
import { rateLimit, requirePermission, sessionKeyOf } from '../middleware/index.js';
import { aggregateSearch } from '../search/aggregator.js';
import { parseQuery } from '../search/parser.js';

/**
 * Search endpoints.
 *
 * Two shapes of the same operation:
 *
 *   GET /search         — one JSON response. Simple, cacheable, what a
 *                         shared link or a server-rendered page uses.
 *   GET /search/stream  — server-sent events. What the app uses, so the user
 *                         sees sources arriving instead of a spinner.
 *
 * SSE rather than WebSockets because the traffic is one-directional and SSE
 * survives proxies, reconnects by itself and needs no protocol upgrade. The
 * stream carries real stage transitions; there is no synthetic progress.
 */

export async function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const searchLimiter = rateLimit(
    { config: ctx.config, log: ctx.log, sessions: ctx.sessions, cache: ctx.cache },
    { perMinute: ctx.config.rateLimits.searchPerMinutePerSession, bucket: 'search' },
  );

  app.get(
    '/api/v1/search',
    { preHandler: [requirePermission('search:basic'), searchLimiter] },
    async (request, reply) => {
      const parsed = parseSearchQuery(request.query as Record<string, string | undefined>, ctx);
      const providerIds = await resolveProviders(ctx, parsed.mode);

      if (providerIds.length === 0) {
        // No source can answer. This is a real state — every provider pending
        // verification, or all disabled — and it gets an explicit answer
        // rather than an empty result set that reads as "nothing matches".
        throw new AppError('ERROR_SOURCE_UNAVAILABLE', {
          details: { mode: parsed.mode },
        });
      }

      const controller = new AbortController();
      // A client that disconnects should not leave provider calls running
      // against our quota.
      request.raw.on('close', () => controller.abort());

      const result = await aggregateSearch(ctx.aggregatorDeps, {
        request: parsed,
        requestId: request.requestId,
        signal: controller.signal,
        providerIds,
      });

      void ctx.telemetry.recordSearch({
        requestId: request.requestId,
        mode: parsed.mode,
        countryCode: parsed.countryCode,
        summary: result.summary,
      });

      if (request.principal.kind === 'user' && request.profile?.privacy.storeSearchHistory) {
        void ctx.userStore.recordSearchHistory({
          userId: request.principal.userId,
          query: parsed.query,
          mode: parsed.mode,
          resultCount: result.items.length,
          countryCode: parsed.countryCode,
        });
      }

      // Cache headers reflect whether any contributing provider permits it.
      reply.header('cache-control', result.summary.containsDemoData ? 'no-store' : 'private, max-age=30');
      return result;
    },
  );

  app.get(
    '/api/v1/search/stream',
    { preHandler: [requirePermission('search:basic'), searchLimiter] },
    async (request, reply) => {
      const parsed = parseSearchQuery(request.query as Record<string, string | undefined>, ctx);
      const providerIds = await resolveProviders(ctx, parsed.mode);

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // Stops nginx and similar from buffering the stream into one chunk,
        // which would defeat the entire point.
        'x-accel-buffering': 'no',
        'x-request-id': request.requestId,
      });

      const controller = new AbortController();
      let closed = false;

      const send = (event: SearchStreamEvent): void => {
        if (closed) return;
        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          closed = true;
        }
      };

      // A comment frame every 15s keeps intermediaries from timing out a
      // stream that is legitimately waiting on a slow provider.
      const heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(': keepalive\n\n');
      }, 15_000);

      const finish = (): void => {
        closed = true;
        clearInterval(heartbeat);
        controller.abort();
        try {
          reply.raw.end();
        } catch {
          /* already closed */
        }
      };

      request.raw.on('close', finish);

      try {
        if (providerIds.length === 0) {
          send({
            type: 'error',
            code: 'ERROR_SOURCE_UNAVAILABLE',
            messageKey: 'errors.ERROR_SOURCE_UNAVAILABLE',
            requestId: request.requestId,
          });
          finish();
          return reply;
        }

        const result = await aggregateSearch(ctx.aggregatorDeps, {
          request: parsed,
          requestId: request.requestId,
          signal: controller.signal,
          providerIds,
          onEvent: send,
        });

        void ctx.telemetry.recordSearch({
          requestId: request.requestId,
          mode: parsed.mode,
          countryCode: parsed.countryCode,
          summary: result.summary,
        });

        if (request.principal.kind === 'user' && request.profile?.privacy.storeSearchHistory) {
          void ctx.userStore.recordSearchHistory({
            userId: request.principal.userId,
            query: parsed.query,
            mode: parsed.mode,
            resultCount: result.items.length,
            countryCode: parsed.countryCode,
          });
        }
      } catch (error) {
        ctx.log.error('Search stream failed', { requestId: request.requestId, error });
        send({
          type: 'error',
          code: error instanceof AppError ? error.code : 'ERROR_INTERNAL',
          messageKey:
            error instanceof AppError ? `errors.${error.code}` : 'errors.ERROR_INTERNAL',
          requestId: request.requestId,
        });
      } finally {
        finish();
      }

      return reply;
    },
  );

  /**
   * Parse-only endpoint. Lets the UI show what it understood from the query as
   * the user types, without spending a provider call to find out.
   */
  app.get(
    '/api/v1/search/parse',
    { preHandler: [requirePermission('search:basic')] },
    async (request) => {
      const query = (request.query as { q?: string }).q ?? '';
      if (query.trim().length === 0) throw new AppError('ERROR_QUERY_TOO_SHORT');

      const providerIds = await ctx.policies.providerIds();
      const profile = request.profile;

      return {
        intent: parseQuery(query, {
          countryCode: profile?.preferences.countryCode ?? ctx.defaults.countryCode,
          currency: profile?.preferences.currency ?? ctx.defaults.currency,
          locale: profile?.preferences.locale ?? ctx.defaults.locale,
          knownProviderIds: providerIds,
        }),
      };
    },
  );

  /** Suggested example searches for the home page. */
  app.get('/api/v1/search/examples', async (request) => {
    const locale = request.profile?.preferences.locale ?? ctx.defaults.locale;
    return { examples: ctx.searchExamples(locale) };
  });
}

/**
 * Validates and normalizes query parameters.
 *
 * Everything is bounded here rather than trusted: page size is clamped,
 * country and currency are checked against the supported sets, and an unknown
 * sort falls back rather than reaching the aggregator.
 */
function parseSearchQuery(
  query: Record<string, string | undefined>,
  ctx: AppContext,
): SearchRequest {
  const raw = (query.q ?? '').trim();
  if (raw.length === 0) throw new AppError('ERROR_QUERY_TOO_SHORT');
  if (raw.length > 300) {
    throw new AppError('ERROR_VALIDATION', { details: { field: 'q', maxLength: 300 } });
  }

  const mode = query.source ?? query.mode ?? 'all';
  if (!isSourceMode(mode)) {
    throw new AppError('ERROR_UNSUPPORTED_SOURCE', { details: { mode } });
  }

  const countryCode = (query.country ?? ctx.defaults.countryCode).toUpperCase();
  if (!isSupportedCountry(countryCode)) {
    throw new AppError('ERROR_UNSUPPORTED_COUNTRY', { details: { countryCode } });
  }

  const currency = (query.currency ?? ctx.defaults.currency).toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw new AppError('ERROR_UNSUPPORTED_CURRENCY', { details: { currency } });
  }

  const sort: SortOption = (SORT_OPTIONS as readonly string[]).includes(query.sort ?? '')
    ? (query.sort as SortOption)
    : 'MOST_RELEVANT';

  const page = clampInt(query.page, 1, 1, 20);
  const pageSize = clampInt(
    query.pageSize,
    ctx.config.search.defaultPageSize,
    1,
    ctx.config.search.maxPageSize,
  );

  const filters: SearchFilters = {
    ...(parseMoney(query.priceMin, currency) ? { priceMin: parseMoney(query.priceMin, currency)! } : {}),
    ...(parseMoney(query.priceMax, currency) ? { priceMax: parseMoney(query.priceMax, currency)! } : {}),
    ...(query.brands ? { brands: splitList(query.brands, 10) } : {}),
    ...(query.minRating ? { minRating: clampFloat(query.minRating, 0, 0, 5) } : {}),
    ...(query.minReviews ? { minReviewCount: clampInt(query.minReviews, 0, 0, 1_000_000) } : {}),
    ...(query.freeShipping === 'true' ? { freeShippingOnly: true } : {}),
    ...(query.maxDeliveryDays
      ? { maxDeliveryDays: clampInt(query.maxDeliveryDays, 60, 1, 365) }
      : {}),
    ...(query.withCoupon === 'true' ? { withCouponOnly: true } : {}),
    ...(query.withDeal === 'true' ? { withDealOnly: true } : {}),
    ...(query.exactMatch === 'true' ? { exactMatchOnly: true } : {}),
    ...(query.category ? { categoryPath: splitList(query.category, 4) } : {}),
    ...(query.allowAboveBudget === 'true' ? { allowAboveBudget: true } : {}),
  };

  return {
    query: raw,
    mode,
    filters,
    sort,
    page,
    pageSize,
    countryCode,
    currency,
    locale: query.locale ?? ctx.defaults.locale,
  };
}

/**
 * Resolves a route to the providers that may actually be queried right now.
 *
 * This is what makes the four routes real rather than cosmetic (rule 6): a
 * provider that is disabled, unconfigured or pending verification is excluded
 * here, so `all` genuinely means "every source that can answer".
 */
async function resolveProviders(
  ctx: AppContext,
  mode: string,
): Promise<ReadonlyArray<string>> {
  const searchable = await ctx.policies.searchableProviderIds();
  if (mode === 'all') return searchable;
  return searchable.filter((providerId) => providerId === mode);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseMoney(raw: string | undefined, currency: string) {
  if (!raw) return null;
  return moneyFromDecimal(raw, currency);
}

function splitList(raw: string, limit: number): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

export { newId };
