import { type ProviderHealth, type ProviderRuntimeState, newId } from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config/index.js';

/**
 * Source health.
 *
 * Keeps a rolling in-memory window per provider for the admin Source Health
 * panel and for the ranking layer's reliability weight, and writes each call
 * to `provider_call_log` for history.
 *
 * The in-memory window is what ranking reads, because a search cannot afford a
 * query per provider to find out how healthy it is. The database rows are what
 * an operator reads when something has been wrong for an hour.
 *
 * Writes are fire-and-forget: telemetry must never slow down or fail the
 * request it describes.
 */

export interface CallRecord {
  readonly operation: string;
  readonly durationMs: number;
  readonly status: 'OK' | 'EMPTY' | 'FAILED' | 'TIMEOUT' | 'RATE_LIMITED' | 'CIRCUIT_OPEN';
  readonly errorCode?: string;
  readonly rateLimited: boolean;
  readonly requestId?: string;
  readonly httpStatus?: number;
}

interface Window {
  readonly durations: number[];
  successes: number;
  failures: number;
  rateLimited: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastErrorCode: string | null;
}

const WINDOW_SIZE = 200;

export interface ProviderHealthTracker {
  record(providerId: string, call: CallRecord): void;
  snapshot(providerId: string): ProviderHealth | null;
  all(): ReadonlyArray<ProviderHealth>;
  /** Reliability weight per provider, 0..1, used by ranking. */
  reliabilityMap(): ReadonlyMap<string, number>;
  /** Rolling stats from the database, for the admin panel's longer window. */
  history(hours: number): Promise<ReadonlyArray<ProviderHistoryRow>>;
}

export interface ProviderHistoryRow {
  readonly providerId: string;
  readonly calls: number;
  readonly failures: number;
  readonly rateLimited: number;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly successRate: number | null;
}

export function createHealthTracker(
  db: Database,
  config: AppConfig,
  log: Logger,
): ProviderHealthTracker {
  const windows = new Map<string, Window>();

  function windowFor(providerId: string): Window {
    const existing = windows.get(providerId);
    if (existing) return existing;
    const created: Window = {
      durations: [],
      successes: 0,
      failures: 0,
      rateLimited: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    };
    windows.set(providerId, created);
    return created;
  }

  return {
    record(providerId: string, call: CallRecord): void {
      const window = windowFor(providerId);

      window.durations.push(call.durationMs);
      if (window.durations.length > WINDOW_SIZE) window.durations.shift();

      if (call.status === 'OK' || call.status === 'EMPTY') {
        window.successes += 1;
        window.lastSuccessAt = Date.now();
      } else {
        window.failures += 1;
        window.lastErrorAt = Date.now();
        window.lastErrorCode = call.errorCode ?? call.status;
      }
      if (call.rateLimited) window.rateLimited += 1;

      // Keep the window from being dominated by ancient history.
      if (window.successes + window.failures > WINDOW_SIZE) {
        const scale = WINDOW_SIZE / (window.successes + window.failures);
        window.successes = Math.round(window.successes * scale);
        window.failures = Math.round(window.failures * scale);
        window.rateLimited = Math.round(window.rateLimited * scale);
      }

      const purgeAfter = new Date(
        Date.now() + config.retention.providerCallLogDays * 86_400_000,
      );

      void db
        .query(
          `INSERT INTO provider_call_log
             (call_id, provider_id, operation, status, error_code, duration_ms,
              http_status, rate_limited, request_id, purge_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            newId('pcl'),
            providerId,
            call.operation,
            call.status,
            call.errorCode ?? null,
            call.durationMs,
            call.httpStatus ?? null,
            call.rateLimited,
            call.requestId ?? null,
            purgeAfter,
          ],
        )
        .catch((error: unknown) => {
          log.debug('Provider call log write failed', { providerId, error });
        });
    },

    snapshot(providerId: string): ProviderHealth | null {
      const window = windows.get(providerId);
      if (!window) return null;
      return buildSnapshot(providerId, window);
    },

    all(): ReadonlyArray<ProviderHealth> {
      return [...windows.entries()].map(([providerId, window]) =>
        buildSnapshot(providerId, window),
      );
    },

    /**
     * Reliability weight. A provider with no recent calls gets a neutral 0.8
     * rather than 0 — a cold start must not demote a healthy source, and it
     * must not promote one either.
     */
    reliabilityMap(): ReadonlyMap<string, number> {
      const out = new Map<string, number>();
      for (const [providerId, window] of windows) {
        const total = window.successes + window.failures;
        out.set(providerId, total < 5 ? 0.8 : window.successes / total);
      }
      return out;
    },

    async history(hours: number): Promise<ReadonlyArray<ProviderHistoryRow>> {
      const result = await db.query<{
        provider_id: string;
        calls: string;
        failures: string;
        rate_limited: string;
        p50: string | null;
        p95: string | null;
      }>(
        `SELECT provider_id,
                count(*)::text AS calls,
                count(*) FILTER (WHERE status NOT IN ('OK','EMPTY'))::text AS failures,
                count(*) FILTER (WHERE rate_limited)::text AS rate_limited,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_ms)::text AS p50,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95
           FROM provider_call_log
          WHERE created_at > now() - ($1 || ' hours')::interval
          GROUP BY provider_id`,
        [String(Math.max(1, Math.min(hours, 720)))],
      );

      return result.rows.map((row) => {
        const calls = Number.parseInt(row.calls, 10);
        const failures = Number.parseInt(row.failures, 10);
        return {
          providerId: row.provider_id,
          calls,
          failures,
          rateLimited: Number.parseInt(row.rate_limited, 10),
          p50LatencyMs: row.p50 === null ? null : Number.parseInt(row.p50, 10),
          p95LatencyMs: row.p95 === null ? null : Number.parseInt(row.p95, 10),
          successRate: calls === 0 ? null : (calls - failures) / calls,
        };
      });
    },
  };
}

function buildSnapshot(providerId: string, window: Window): ProviderHealth {
  const total = window.successes + window.failures;
  const sorted = [...window.durations].sort((a, b) => a - b);

  return {
    providerId,
    runtimeState: deriveRuntimeState(window),
    successRate1h: total === 0 ? null : window.successes / total,
    p50LatencyMs: percentile(sorted, 0.5),
    p95LatencyMs: percentile(sorted, 0.95),
    lastSuccessAt: window.lastSuccessAt ? new Date(window.lastSuccessAt).toISOString() : null,
    lastErrorAt: window.lastErrorAt ? new Date(window.lastErrorAt).toISOString() : null,
    lastErrorCode: window.lastErrorCode,
    // The breaker's own state lives in the adapter; this is the health view's
    // inference from observed outcomes, which is what an operator cares about.
    circuitState: window.failures >= 5 && window.successes === 0 ? 'OPEN' : 'CLOSED',
    rateLimit: {
      requestsPerSecond: 0,
      burst: 0,
      currentlyThrottled: window.rateLimited > 0 && window.failures > window.successes,
    },
  };
}

/**
 * Runtime state from observed behaviour. DEGRADED rather than UNAVAILABLE
 * while some calls still succeed, because the product is usable and the
 * distinction matters on the status panel.
 */
function deriveRuntimeState(window: Window): ProviderRuntimeState {
  const total = window.successes + window.failures;
  if (total === 0) return 'ACTIVE';
  const successRate = window.successes / total;
  if (successRate === 0 && window.failures >= 3) return 'UNAVAILABLE';
  if (successRate < 0.8) return 'DEGRADED';
  return 'ACTIVE';
}

function percentile(sorted: ReadonlyArray<number>, fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? null;
}
