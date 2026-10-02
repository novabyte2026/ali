import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { AppError } from '@shelf/shared';
import type { AppContext } from './context.js';
import { rateLimit, registerMiddleware } from './middleware/index.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProductRoutes } from './routes/products.js';
import { registerAffiliateRoutes } from './routes/affiliate.js';
import { registerCouponRoutes } from './routes/coupons.js';
import { registerDealRoutes } from './routes/deals.js';
import { registerUserRoutes } from './routes/user.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';

/**
 * Builds the HTTP application.
 *
 * Separated from `server.ts` so tests can construct the app with a test
 * context and call it in-process via `app.inject`, with no port binding and no
 * real network — which is what makes the authorization tests in tests/e2e able
 * to hit endpoints directly as a guest.
 */

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // We log through our own redacting logger.
    trustProxy: true,
    // 1 MiB is generous for JSON bodies here and small enough that a hostile
    // client cannot make us buffer much.
    bodyLimit: 1024 * 1024,
    // A long path parameter is the signature of an attempt to overflow
    // something downstream.
    routerOptions: { maxParamLength: 256 },
  });

  await app.register(cookie, {
    // Cookies are opaque and compared against a stored hash, so no signing
    // secret is needed here; the value carries no claims of its own.
    hook: 'onRequest',
    parseOptions: {},
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and server-to-server requests arrive with no Origin.
      if (!origin) {
        callback(null, true);
        return;
      }
      const allowed = ctx.config.http.corsAllowedOrigins.includes(origin.replace(/\/$/, ''));
      // A rejected origin is not an error to the browser; it simply does not
      // get the credentialed response.
      callback(null, allowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'accept'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  registerMiddleware(app, {
    config: ctx.config,
    log: ctx.log,
    sessions: ctx.sessions,
    cache: ctx.cache,
  });

  // A blanket limit under which the per-route limits sit, so an endpoint added
  // without its own limiter is not unbounded.
  const globalLimiter = rateLimit(
    { config: ctx.config, log: ctx.log, sessions: ctx.sessions, cache: ctx.cache },
    { perMinute: ctx.config.rateLimits.apiPerMinutePerSession, bucket: 'api' },
  );

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health') || request.url.startsWith('/ready')) return;
    await globalLimiter(request, reply);
  });

  await registerMetaRoutes(app, ctx);
  await registerAuthRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerProductRoutes(app, ctx);
  await registerAffiliateRoutes(app, ctx);
  await registerCouponRoutes(app, ctx);
  await registerDealRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerAnalyticsRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);

  // Anything not matched under /api is a client error, answered in our own
  // error shape rather than Fastify's default.
  app.get('/api/*', async (request) => {
    throw new AppError('ERROR_NOT_FOUND', { details: { path: request.url.split('?')[0] ?? '' } });
  });

  return app;
}
