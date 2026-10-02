import {
  type AnalyticsEventType,
  type SearchSummary,
  ALLOWED_EVENT_PROPERTIES,
  ANALYTICS_EVENT_TYPES,
  newId,
} from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';

/**
 * Telemetry and analytics.
 *
 * Two separate pipelines on purpose (rule 168):
 *
 *   search_telemetry  — how the system is performing. Latency, which sources
 *                       answered, cache effectiveness, zero-result rate. No
 *                       user id, ever. This is operations data.
 *   analytics_events  — what people did. Session-scoped by default; a user id
 *                       is attached only with explicit consent.
 *
 * Property allowlisting happens on ingest rather than at query time, so a
 * well-meaning frontend change cannot start sending a search term or an e-mail
 * address into the analytics table. Anything not on the list for that event
 * type is dropped silently and counted.
 *
 * Every write is fire-and-forget. Analytics must never slow down or fail the
 * request it describes.
 */

export interface TelemetryService {
  recordSearch(args: {
    readonly requestId: string;
    readonly mode: string;
    readonly countryCode: string;
    readonly summary: SearchSummary;
  }): Promise<void>;

  recordEvent(args: {
    readonly type: string;
    readonly sessionHash: string;
    readonly userId: string | null;
    readonly providerId?: string | null;
    readonly countryCode?: string | null;
    readonly deviceType: 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN';
    readonly properties: Record<string, unknown>;
  }): Promise<void>;

  searchMetrics(hours: number): Promise<SearchMetrics>;
  topSearchTerms(limit: number): Promise<ReadonlyArray<{ readonly term: string; readonly count: number }>>;
  eventCounts(hours: number): Promise<ReadonlyArray<{ readonly type: string; readonly count: number }>>;
  droppedPropertyCount(): number;
}

export interface SearchMetrics {
  readonly searches: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly cacheHitRate: number | null;
  readonly zeroResultRate: number | null;
  readonly partialSourceRate: number | null;
}

export function createTelemetryService(
  db: Database,
  config: AppConfig,
  log: Logger,
): TelemetryService {
  let droppedProperties = 0;

  return {
    async recordSearch({ requestId, mode, countryCode, summary }) {
      const purgeAfter = new Date(Date.now() + config.retention.telemetryDays * 86_400_000);
      try {
        await db.query(
          `INSERT INTO search_telemetry
             (telemetry_id, request_id, mode, country_code, providers_queried,
              providers_succeeded, result_count, duration_ms, cache_hit,
              had_budget, zero_results, purge_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            newId('tel'),
            requestId,
            mode,
            countryCode,
            summary.providersQueried,
            summary.providersSucceeded,
            summary.totalResults,
            summary.elapsedMs,
            summary.cacheHit,
            Boolean(summary.intent.budgetMax ?? summary.intent.budgetMin),
            summary.totalResults === 0,
            purgeAfter,
          ],
        );
      } catch (error) {
        log.debug('Search telemetry write failed', { error });
      }
    },

    async recordEvent({ type, sessionHash, userId, providerId, countryCode, deviceType, properties }) {
      if (!(ANALYTICS_EVENT_TYPES as readonly string[]).includes(type)) {
        // An unknown event type is a frontend/backend version mismatch, not
        // data to store.
        log.debug('Unknown analytics event type dropped', { type });
        return;
      }

      const eventType = type as AnalyticsEventType;
      const allowed = new Set(ALLOWED_EVENT_PROPERTIES[eventType]);
      const filtered: Record<string, string | number | boolean | null> = {};

      for (const [key, value] of Object.entries(properties)) {
        if (!allowed.has(key)) {
          droppedProperties += 1;
          continue;
        }
        // Scalars only. An object or array could carry anything.
        if (value === null) filtered[key] = null;
        else if (typeof value === 'string') filtered[key] = value.slice(0, 120);
        else if (typeof value === 'number' && Number.isFinite(value)) filtered[key] = value;
        else if (typeof value === 'boolean') filtered[key] = value;
        else droppedProperties += 1;
      }

      const purgeAfter = new Date(Date.now() + config.retention.analyticsEventDays * 86_400_000);

      try {
        await db.query(
          `INSERT INTO analytics_events
             (event_id, event_type, session_hash, user_id, provider_id,
              country_code, device_type, properties, purge_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            newId('ae'),
            eventType,
            sessionHash,
            userId,
            providerId ?? null,
            countryCode ?? null,
            deviceType,
            JSON.stringify(filtered),
            purgeAfter,
          ],
        );
      } catch (error) {
        log.debug('Analytics write failed', { error });
      }
    },

    async searchMetrics(hours: number): Promise<SearchMetrics> {
      const result = await db.query<{
        searches: string;
        p50: string | null;
        p95: string | null;
        cache_hits: string;
        zero_results: string;
        partial: string;
      }>(
        `SELECT count(*)::text AS searches,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)::text AS p50,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95,
                count(*) FILTER (WHERE cache_hit)::text AS cache_hits,
                count(*) FILTER (WHERE zero_results)::text AS zero_results,
                count(*) FILTER (WHERE providers_succeeded < providers_queried)::text AS partial
           FROM search_telemetry
          WHERE created_at > now() - ($1 || ' hours')::interval`,
        [String(Math.max(1, Math.min(hours, 720)))],
      );

      const row = result.rows[0];
      const searches = row ? Number.parseInt(row.searches, 10) : 0;

      return {
        searches,
        p50LatencyMs: row?.p50 ? Number.parseInt(row.p50, 10) : null,
        p95LatencyMs: row?.p95 ? Number.parseInt(row.p95, 10) : null,
        cacheHitRate: searches === 0 ? null : Number.parseInt(row?.cache_hits ?? '0', 10) / searches,
        zeroResultRate:
          searches === 0 ? null : Number.parseInt(row?.zero_results ?? '0', 10) / searches,
        partialSourceRate:
          searches === 0 ? null : Number.parseInt(row?.partial ?? '0', 10) / searches,
      };
    },

    /**
     * Popular search terms for the admin console.
     *
     * Only available from the history of users who opted into storing it. We
     * do not keep a shadow copy of every guest's query in order to produce a
     * leaderboard, and a term appearing fewer than five times is excluded so
     * no individual's search is identifiable from an aggregate.
     */
    async topSearchTerms(limit: number) {
      const result = await db.query<{ query: string; count: string }>(
        `SELECT lower(trim(query)) AS query, count(*)::text AS count
           FROM search_history
          WHERE created_at > now() - INTERVAL '30 days'
          GROUP BY lower(trim(query))
         HAVING count(*) >= 5
          ORDER BY count(*) DESC
          LIMIT $1`,
        [Math.min(limit, 100)],
      );
      return result.rows.map((row) => ({
        term: row.query,
        count: Number.parseInt(row.count, 10),
      }));
    },

    async eventCounts(hours: number) {
      const result = await db.query<{ event_type: string; count: string }>(
        `SELECT event_type, count(*)::text AS count
           FROM analytics_events
          WHERE occurred_at > now() - ($1 || ' hours')::interval
          GROUP BY event_type
          ORDER BY count(*) DESC`,
        [String(Math.max(1, Math.min(hours, 720)))],
      );
      return result.rows.map((row) => ({
        type: row.event_type,
        count: Number.parseInt(row.count, 10),
      }));
    },

    droppedPropertyCount(): number {
      return droppedProperties;
    },
  };
}
