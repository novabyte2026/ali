import type { JobContext, JobDefinition, JobResult } from '../runner.js';

/**
 * Affiliate link monitor.
 *
 * Watches for commission leaking away silently. A rising share of clicks with
 * no tracking id means a programme's link generation is failing — the user
 * still reaches the store, so nothing looks broken, but every one of those
 * visits earns nothing. This surfaces it as a compliance event before it shows
 * up as a revenue shortfall weeks later.
 */

/** Share of untracked clicks over the window that warrants raising it. */
const UNTRACKED_RATIO_THRESHOLD = 0.2;
const MIN_CLICKS_TO_JUDGE = 20;

export const affiliateLinkMonitorJob: JobDefinition = {
  name: 'affiliate-link-monitor',
  intervalMs: 60 * 60 * 1000,
  initialDelayMs: 3 * 60 * 1000,
  lockTtlMs: 5 * 60 * 1000,

  async run(ctx: JobContext): Promise<JobResult> {
    const result = await ctx.db.query<{
      provider_id: string;
      clicks: string;
      untracked: string;
      invalid: string;
    }>(
      `SELECT provider_id,
              count(*)::text AS clicks,
              count(*) FILTER (WHERE tracking_id IS NULL)::text AS untracked,
              count(*) FILTER (WHERE link_status <> 'OK')::text AS invalid
         FROM affiliate_clicks
        WHERE created_at > now() - INTERVAL '6 hours'
        GROUP BY provider_id`,
    );

    let raised = 0;

    for (const row of result.rows) {
      const clicks = Number.parseInt(row.clicks, 10);
      if (clicks < MIN_CLICKS_TO_JUDGE) continue;

      const untracked = Number.parseInt(row.untracked, 10);
      const invalid = Number.parseInt(row.invalid, 10);
      const ratio = untracked / clicks;

      if (ratio < UNTRACKED_RATIO_THRESHOLD && invalid === 0) continue;

      try {
        const recent = await ctx.db.query(
          `SELECT 1 FROM compliance_events
            WHERE kind = 'AFFILIATE_LINK_INVALID' AND provider_id = $1
              AND created_at > now() - INTERVAL '5 hours'
            LIMIT 1`,
          [row.provider_id],
        );
        if ((recent.rowCount ?? 0) > 0) continue;

        await ctx.db.query(
          `INSERT INTO compliance_events
             (event_id, kind, provider_id, severity, detail)
           VALUES ($1, 'AFFILIATE_LINK_INVALID', $2, 'WARNING', $3)`,
          [
            `ce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            row.provider_id,
            JSON.stringify({
              clicks,
              untracked,
              invalid,
              untrackedRatio: Number(ratio.toFixed(3)),
              note: 'Elevated untracked or invalid affiliate clicks — link generation may be failing.',
            }),
          ],
        );
        raised += 1;
      } catch (error) {
        ctx.log.warn('Affiliate link monitor write failed', { providerId: row.provider_id, error });
      }
    }

    return { itemsProcessed: result.rows.length, itemsFailed: 0, detail: { raised } };
  },
};
