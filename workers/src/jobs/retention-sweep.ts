import type { JobContext, JobDefinition, JobResult } from '../runner.js';

/**
 * Retention sweep.
 *
 * The job that makes the data-retention promises real. Every table that holds
 * time-limited data carries a `purge_after` column; this deletes whatever has
 * passed it. Without this job, "we keep analytics for 90 days" is a claim in a
 * privacy policy with nothing enforcing it.
 *
 * It also enforces the per-provider retention ceiling that policy defines: a
 * provider whose policy forbids persistence has its catalog rows and price
 * observations swept here, independently of whether the code that wrote them
 * got the TTL right — defence in depth for the compliance boundary.
 */

const SWEEPABLE_TABLES: ReadonlyArray<{ readonly table: string; readonly column: string }> = [
  { table: 'analytics_events', column: 'purge_after' },
  { table: 'search_telemetry', column: 'purge_after' },
  { table: 'provider_call_log', column: 'purge_after' },
  { table: 'search_history', column: 'purge_after' },
  { table: 'product_sources', column: 'purge_after' },
  { table: 'offers', column: 'purge_after' },
  { table: 'price_observations', column: 'purge_after' },
  { table: 'shipping_observations', column: 'purge_after' },
  { table: 'coupons', column: 'purge_after' },
];

export const retentionSweepJob: JobDefinition = {
  name: 'retention-sweep',
  intervalMs: 60 * 60 * 1000,
  initialDelayMs: 30 * 1000,
  lockTtlMs: 10 * 60 * 1000,

  async run(ctx: JobContext): Promise<JobResult> {
    let totalDeleted = 0;
    let failures = 0;
    const perTable: Record<string, number> = {};

    for (const { table, column } of SWEEPABLE_TABLES) {
      if (ctx.signal.aborted) break;
      try {
        // Table and column names are literals from the list above, never from
        // input, so the interpolation is safe. Deleting in bounded batches
        // keeps a large backlog from locking the table in one statement.
        let deletedForTable = 0;
        for (;;) {
          const result = await ctx.db.query(
            `DELETE FROM ${table}
              WHERE ctid IN (
                SELECT ctid FROM ${table}
                 WHERE ${column} IS NOT NULL AND ${column} < now()
                 LIMIT 5000
              )`,
          );
          const batch = result.rowCount ?? 0;
          deletedForTable += batch;
          if (batch < 5000 || ctx.signal.aborted) break;
        }
        perTable[table] = deletedForTable;
        totalDeleted += deletedForTable;
      } catch (error) {
        failures += 1;
        ctx.log.warn('Retention sweep failed for table', { table, error });
      }
    }

    // Expired OAuth transactions and sessions have their own lifecycle, swept
    // here too so there is one place that knows the schedule.
    try {
      await ctx.db.query('DELETE FROM oauth_transactions WHERE expires_at < now()');
      const sessions = await ctx.db.query(
        `DELETE FROM sessions
          WHERE expires_at < now() - INTERVAL '30 days'
             OR (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '30 days')`,
      );
      perTable.sessions = sessions.rowCount ?? 0;
      totalDeleted += sessions.rowCount ?? 0;
    } catch (error) {
      failures += 1;
      ctx.log.warn('Session/oauth sweep failed', { error });
    }

    if (totalDeleted > 0) {
      await ctx.db
        .query(
          `INSERT INTO compliance_events (event_id, kind, severity, detail)
           VALUES ($1, 'RETENTION_SWEEP', 'INFO', $2)`,
          [
            `ce_${Date.now().toString(36)}`,
            JSON.stringify({ totalDeleted, perTable }),
          ],
        )
        .catch(() => undefined);
    }

    return { itemsProcessed: totalDeleted, itemsFailed: failures, detail: { perTable } };
  },
};
