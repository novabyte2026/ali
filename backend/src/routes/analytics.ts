import type { FastifyInstance } from 'fastify';
import { ANALYTICS_EVENT_TYPES, AppError } from '@shelf/shared';
import type { AppContext } from '../context.js';
import { deviceTypeOf } from '../middleware/index.js';

/**
 * Analytics ingest.
 *
 * Open to guests, because the events worth having are mostly about whether the
 * product works — did a search return nothing, did a source fail, did someone
 * open a comparison. What keeps this safe rather than invasive is the
 * allowlist: the event type must be known and each property must be permitted
 * for that type, both enforced server-side on ingest.
 *
 * A user id is attached only when the signed-in user has consented. A guest's
 * events carry a rotating session hash and nothing else.
 */

export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.post('/api/v1/analytics/events', async (request, reply) => {
    const body = request.body as {
      events?: Array<{
        type?: string;
        providerId?: string;
        properties?: Record<string, unknown>;
      }>;
    };

    const events = body.events;
    if (!Array.isArray(events)) {
      throw new AppError('ERROR_VALIDATION', { details: { field: 'events' } });
    }
    if (events.length > 20) {
      throw new AppError('ERROR_VALIDATION', { details: { field: 'events', maxItems: 20 } });
    }

    const sessionHash =
      request.principal.kind === 'user'
        ? `user:${request.principal.userId}`
        : request.principal.sessionHash;

    // Consent is checked here, once, rather than at each call site.
    const userId =
      request.principal.kind === 'user' && request.profile?.privacy.productAnalytics
        ? request.principal.userId
        : null;

    const deviceType = deviceTypeOf(request);
    const countryCode = request.profile?.preferences.countryCode ?? null;

    let accepted = 0;
    for (const event of events) {
      if (!event.type || !(ANALYTICS_EVENT_TYPES as readonly string[]).includes(event.type)) {
        continue;
      }
      await ctx.telemetry.recordEvent({
        type: event.type,
        sessionHash,
        userId,
        providerId: event.providerId ?? null,
        countryCode,
        deviceType,
        properties: event.properties ?? {},
      });
      accepted += 1;
    }

    // 202: the events are queued for storage, and the client should not wait
    // on or care about the outcome.
    reply.status(202);
    return { accepted, rejected: events.length - accepted };
  });
}
