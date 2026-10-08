import { POLICY_REVIEW_INTERVAL_DAYS } from '@shelf/shared';
import type { JobContext, JobDefinition, JobResult } from '../runner.js';

/**
 * Compliance monitor.
 *
 * Raises the things a human needs to act on before anyone notices them in
 * production: a policy that has gone past its review interval, a programme
 * whose disclosure text is not configured, a provider enabled with a
 * capability still marked VERIFICATION_REQUIRED.
 *
 * It does not change anything. It writes compliance events, which surface in
 * the admin Compliance Center. The principle (rule 255) is that a release
 * should never be the moment someone discovers a policy was last checked eight
 * months ago — this makes that visible continuously instead.
 */
export const complianceMonitorJob: JobDefinition = {
  name: 'compliance-monitor',
  intervalMs: 6 * 60 * 60 * 1000,
  initialDelayMs: 2 * 60 * 1000,
  lockTtlMs: 5 * 60 * 1000,

  async run(ctx: JobContext): Promise<JobResult> {
    let raised = 0;

    // --- Stale policies ----------------------------------------------------
    const stalePolicies = await ctx.db.query<{
      provider_id: string;
      policy_version: string;
      age_days: number | null;
    }>(
      `SELECT provider_id, policy_version,
              EXTRACT(DAY FROM now() - policy_checked_at)::int AS age_days
         FROM provider_policies
        WHERE superseded_at IS NULL
          AND (policy_checked_at IS NULL OR policy_checked_at < now() - ($1 || ' days')::interval)`,
      [String(POLICY_REVIEW_INTERVAL_DAYS)],
    );

    for (const row of stalePolicies.rows) {
      await emit(ctx, 'POLICY_VERSION_STALE', row.provider_id, 'WARNING', row.policy_version, {
        ageDays: row.age_days,
        reviewIntervalDays: POLICY_REVIEW_INTERVAL_DAYS,
      });
      raised += 1;
    }

    // --- Enabled providers with unverified capabilities --------------------
    const unverified = await ctx.db.query<{
      provider_id: string;
      policy_version: string;
      capabilities: string[];
    }>(
      `SELECT p.provider_id, pp.policy_version,
              array_agg(pc.capability) AS capabilities
         FROM providers p
         JOIN provider_policies pp ON pp.provider_id = p.provider_id AND pp.superseded_at IS NULL
         JOIN provider_capabilities pc ON pc.policy_id = pp.policy_id
        WHERE p.enabled = TRUE
          AND pc.state = 'VERIFICATION_REQUIRED'
        GROUP BY p.provider_id, pp.policy_version`,
    );

    for (const row of unverified.rows) {
      await emit(ctx, 'VERIFICATION_REQUIRED_SURFACED', row.provider_id, 'WARNING', row.policy_version, {
        capabilities: row.capabilities,
      });
      raised += 1;
    }

    // --- Enabled providers with no disclosure configured -------------------
    const missingDisclosure = await ctx.db.query<{
      provider_id: string;
      policy_version: string;
    }>(
      `SELECT p.provider_id, pp.policy_version
         FROM providers p
         JOIN provider_policies pp ON pp.provider_id = p.provider_id AND pp.superseded_at IS NULL
        WHERE p.enabled = TRUE
          AND (pp.required_disclosures IS NULL OR pp.required_disclosures = '{}'::jsonb)`,
    );

    for (const row of missingDisclosure.rows) {
      await emit(ctx, 'DISCLOSURE_MISSING', row.provider_id, 'CRITICAL', row.policy_version, {});
      raised += 1;
    }

    return { itemsProcessed: raised, itemsFailed: 0, detail: { raised } };
  },
};

/**
 * Emits a compliance event, but only if an equivalent one was not raised in the
 * last window. Without this dedupe the monitor would write the same "policy is
 * stale" row every six hours, drowning the signal it exists to surface.
 */
async function emit(
  ctx: JobContext,
  kind: string,
  providerId: string,
  severity: 'INFO' | 'WARNING' | 'CRITICAL',
  policyVersion: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    const recent = await ctx.db.query(
      `SELECT 1 FROM compliance_events
        WHERE kind = $1 AND provider_id = $2
          AND created_at > now() - INTERVAL '20 hours'
        LIMIT 1`,
      [kind, providerId],
    );
    if ((recent.rowCount ?? 0) > 0) return;

    await ctx.db.query(
      `INSERT INTO compliance_events
         (event_id, kind, provider_id, severity, policy_version, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [`ce_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, kind, providerId, severity, policyVersion, JSON.stringify(detail)],
    );
  } catch (error) {
    ctx.log.warn('Failed to emit compliance event', { kind, providerId, error });
  }
}
