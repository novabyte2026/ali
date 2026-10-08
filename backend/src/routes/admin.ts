import type { FastifyInstance } from 'fastify';
import {
  type Capability,
  type ComplianceStatusReport,
  AppError,
  CAPABILITIES,
  capabilitySeverity,
  isCapability,
  newId,
} from '@shelf/shared';
import type { AppContext } from '../context.js';
import { requireAdmin, requirePermission, requireUser } from '../middleware/index.js';

/**
 * Admin routes.
 *
 * The Compliance Center is the point of the whole console: it answers, per
 * provider, "what are we claiming we may do, when was that last checked, and
 * what is waiting on a human". Every mutating route writes an audit entry
 * with the actor, the before and after state, and a required reason — because
 * a change to what the product tells users about a marketplace needs to be
 * attributable later.
 */

export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const adminOnly = [requireUser, requireAdmin()];

  // --- Compliance Center --------------------------------------------------

  app.get(
    '/api/v1/admin/compliance',
    { preHandler: [...adminOnly, requirePermission('admin:compliance')] },
    async () => {
      const resolved = await ctx.policies.all();

      const reports: ComplianceStatusReport[] = await Promise.all(
        resolved.map(async (entry) => {
          const warnings = await ctx.db.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM compliance_events
              WHERE provider_id = $1
                AND severity <> 'INFO'
                AND created_at > now() - INTERVAL '7 days'`,
            [entry.providerId],
          );

          const needingVerification = CAPABILITIES.filter(
            (capability) => entry.effective[capability] === 'VERIFICATION_REQUIRED',
          );
          const notConfigured = CAPABILITIES.filter(
            (capability) => entry.effective[capability] === 'NOT_CONFIGURED',
          );

          return {
            providerId: entry.providerId,
            policyVersion: entry.policy.policyVersion,
            policyCheckedAt: entry.policy.policyCheckedAt,
            policyAgeDays: entry.policyAgeDays,
            policyStale: entry.policyStale,
            capabilitiesNeedingVerification: needingVerification,
            capabilitiesNotConfigured: notConfigured,
            engagedKillSwitches: entry.killSwitches,
            disclosureConfigured: Object.keys(entry.policy.requiredDisclosures).length > 0,
            openWarnings: Number.parseInt(warnings.rows[0]?.count ?? '0', 10),
          };
        }),
      );

      return {
        reports,
        // The single number an operator should care about before a release.
        actionRequired: reports.reduce(
          (total, report) =>
            total +
            report.capabilitiesNeedingVerification.length +
            (report.policyStale ? 1 : 0) +
            (report.disclosureConfigured ? 0 : 1),
          0,
        ),
      };
    },
  );

  app.get(
    '/api/v1/admin/compliance/:providerId',
    { preHandler: [...adminOnly, requirePermission('admin:compliance')] },
    async (request) => {
      const { providerId } = request.params as { providerId: string };
      const resolved = await ctx.policies.forProvider(providerId);

      return {
        providerId,
        policy: resolved.policy,
        capabilities: CAPABILITIES.map((capability) => ({
          capability,
          declared: resolved.declared[capability],
          effective: resolved.effective[capability],
          severity: capabilitySeverity(resolved.effective[capability]),
          killSwitchEngaged: resolved.killSwitches.includes(capability),
        })),
        policyStale: resolved.policyStale,
        policyAgeDays: resolved.policyAgeDays,
      };
    },
  );

  /**
   * Records a policy review. Supersedes the current policy record and writes a
   * new version, so the change is a new row rather than an edit — the previous
   * position stays readable.
   */
  app.post(
    '/api/v1/admin/compliance/:providerId/review',
    { preHandler: [...adminOnly, requirePermission('admin:compliance')] },
    async (request) => {
      const { providerId } = request.params as { providerId: string };
      const body = request.body as {
        policyVersion?: string;
        capabilityStates?: Record<string, string>;
        notes?: string;
        reason?: string;
        termsUrl?: string;
      };

      if (!body.reason || body.reason.trim().length < 10) {
        // A policy change without a stated reason is not auditable.
        throw new AppError('ERROR_VALIDATION', {
          details: { field: 'reason', reason: 'MUST_EXPLAIN_CHANGE', minLength: 10 },
        });
      }

      // Bound before the transaction closure so the validated value is what
      // gets written, rather than re-reading a mutable body field.
      const reason = body.reason.trim().slice(0, 1000);
      const actorEmail = request.principal.kind === 'user' ? request.principal.email : null;
      const before = await ctx.policies.forProvider(providerId);
      const newPolicyId = newId('pol');
      const version = body.policyVersion ?? `${new Date().toISOString().slice(0, 10)}-review`;

      await ctx.db.tx(async (client) => {
        // Clone the in-force record, then supersede it. Copying first means a
        // reviewer only states what changed.
        await client.query(
          `INSERT INTO provider_policies (
             policy_id, provider_id, policy_version, terms_url, policy_url,
             required_disclosures, disclosure_placements,
             logo_use_permitted, logo_asset_path, name_must_appear_as,
             may_imply_partnership, branding_notes,
             max_cache_seconds, max_retention_seconds, model_training_permitted,
             persistence_permitted, cross_provider_display_permitted,
             allowed_destination_hosts, required_query_params, forbidden_query_params,
             interstitial_redirect_permitted,
             reviewed_by, reviewed_at, policy_checked_at, notes
           )
           SELECT $1, provider_id, $2, coalesce($3, terms_url), policy_url,
                  required_disclosures, disclosure_placements,
                  logo_use_permitted, logo_asset_path, name_must_appear_as,
                  may_imply_partnership, branding_notes,
                  max_cache_seconds, max_retention_seconds, model_training_permitted,
                  persistence_permitted, cross_provider_display_permitted,
                  allowed_destination_hosts, required_query_params, forbidden_query_params,
                  interstitial_redirect_permitted,
                  $4, now(), now(), coalesce($5, notes)
             FROM provider_policies
            WHERE provider_id = $6 AND superseded_at IS NULL`,
          [newPolicyId, version, body.termsUrl ?? null, actorEmail, body.notes ?? null, providerId],
        );

        await client.query(
          `UPDATE provider_policies
              SET superseded_at = now()
            WHERE provider_id = $1 AND superseded_at IS NULL AND policy_id <> $2`,
          [providerId, newPolicyId],
        );

        // Carry the capability states across, applying the reviewer's changes.
        await client.query(
          `INSERT INTO provider_capabilities (provider_id, policy_id, capability, state, rationale)
           SELECT provider_id, $1, capability, state, rationale
             FROM provider_capabilities pc
             JOIN provider_policies pp ON pp.policy_id = pc.policy_id
            WHERE pc.provider_id = $2 AND pp.policy_id <> $1
            ORDER BY pp.effective_from DESC
            ON CONFLICT (policy_id, capability) DO NOTHING`,
          [newPolicyId, providerId],
        );

        for (const [capability, state] of Object.entries(body.capabilityStates ?? {})) {
          if (!isCapability(capability)) continue;
          await client.query(
            `INSERT INTO provider_capabilities (provider_id, policy_id, capability, state, rationale)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (policy_id, capability) DO UPDATE
               SET state = EXCLUDED.state, rationale = EXCLUDED.rationale, updated_at = now()`,
            [providerId, newPolicyId, capability, state, reason],
          );
        }

        await client.query(
          `INSERT INTO audit_logs
             (entry_id, actor_user_id, actor_email, action, subject_type, subject_id,
              before, after, reason, request_id)
           VALUES ($1, $2, $3, 'policy.review', 'provider', $4, $5, $6, $7, $8)`,
          [
            newId('aud'),
            request.principal.kind === 'user' ? request.principal.userId : null,
            actorEmail,
            providerId,
            JSON.stringify({
              policyVersion: before.policy.policyVersion,
              capabilities: before.declared,
            }),
            JSON.stringify({ policyVersion: version, changes: body.capabilityStates ?? {} }),
            reason,
            request.requestId,
          ],
        );
      });

      // Policy is cached in-process; an operator action must take effect now
      // rather than within the TTL.
      ctx.policies.invalidate();
      await ctx.cache.deletePrefix('search:');

      return { policyVersion: version, applied: true };
    },
  );

  /**
   * Kill switch. The mandated ability to withdraw one capability from one
   * provider immediately, without a deploy (rule 200).
   */
  app.post(
    '/api/v1/admin/compliance/:providerId/kill-switch',
    { preHandler: [...adminOnly, requirePermission('admin:compliance')] },
    async (request) => {
      const { providerId } = request.params as { providerId: string };
      const body = request.body as { capability?: string; engaged?: boolean; reason?: string };

      if (!body.capability || !isCapability(body.capability)) {
        throw new AppError('ERROR_VALIDATION', {
          details: { field: 'capability', allowed: [...CAPABILITIES] },
        });
      }
      const engaged = body.engaged !== false;
      const reason = body.reason?.trim() ?? '';
      // Engaging a kill switch without a stated reason is not auditable;
      // releasing one is self-explanatory from the audit entry.
      if (engaged && reason.length < 5) {
        throw new AppError('ERROR_VALIDATION', { details: { field: 'reason', minLength: 5 } });
      }

      const capability = body.capability as Capability;
      const actorEmail = request.principal.kind === 'user' ? request.principal.email : null;

      await ctx.db.tx(async (client) => {
        if (engaged) {
          await client.query(
            `INSERT INTO capability_kill_switches
               (provider_id, capability, engaged, engaged_by, reason)
             VALUES ($1, $2, TRUE, $3, $4)
             ON CONFLICT (provider_id, capability) DO UPDATE
               SET engaged = TRUE, engaged_by = EXCLUDED.engaged_by,
                   engaged_at = now(), released_at = NULL, reason = EXCLUDED.reason`,
            [providerId, capability, actorEmail, reason.slice(0, 500) || null],
          );
        } else {
          await client.query(
            `UPDATE capability_kill_switches
                SET engaged = FALSE, released_at = now()
              WHERE provider_id = $1 AND capability = $2`,
            [providerId, capability],
          );
        }

        await client.query(
          `INSERT INTO compliance_events
             (event_id, kind, provider_id, capability, severity, detail, request_id)
           VALUES ($1, $2, $3, $4, 'CRITICAL', $5, $6)`,
          [
            newId('ce'),
            engaged ? 'KILL_SWITCH_ENGAGED' : 'KILL_SWITCH_RELEASED',
            providerId,
            capability,
            JSON.stringify({ reason: reason || null, actor: actorEmail }),
            request.requestId,
          ],
        );

        await client.query(
          `INSERT INTO audit_logs
             (entry_id, actor_user_id, actor_email, action, subject_type, subject_id,
              after, reason, request_id)
           VALUES ($1, $2, $3, $4, 'capability', $5, $6, $7, $8)`,
          [
            newId('aud'),
            request.principal.kind === 'user' ? request.principal.userId : null,
            actorEmail,
            engaged ? 'killSwitch.engage' : 'killSwitch.release',
            `${providerId}:${capability}`,
            JSON.stringify({ engaged }),
            reason.slice(0, 500) || null,
            request.requestId,
          ],
        );
      });

      ctx.policies.invalidate();
      await ctx.cache.deletePrefix('search:');

      return { providerId, capability, engaged };
    },
  );

  /** Provider master switch. Disabling one source leaves the rest working. */
  app.post(
    '/api/v1/admin/providers/:providerId/enabled',
    { preHandler: [...adminOnly, requirePermission('admin:providers')] },
    async (request) => {
      const { providerId } = request.params as { providerId: string };
      const body = request.body as { enabled?: boolean; reason?: string };

      if (typeof body.enabled !== 'boolean') {
        throw new AppError('ERROR_VALIDATION', { details: { field: 'enabled' } });
      }

      const result = await ctx.db.query(
        'UPDATE providers SET enabled = $2 WHERE provider_id = $1',
        [providerId, body.enabled],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'provider' } });
      }

      await ctx.db.query(
        `INSERT INTO audit_logs
           (entry_id, actor_user_id, actor_email, action, subject_type, subject_id,
            after, reason, request_id)
         VALUES ($1, $2, $3, 'provider.enabled', 'provider', $4, $5, $6, $7)`,
        [
          newId('aud'),
          request.principal.kind === 'user' ? request.principal.userId : null,
          request.principal.kind === 'user' ? request.principal.email : null,
          providerId,
          JSON.stringify({ enabled: body.enabled }),
          body.reason?.slice(0, 500) ?? null,
          request.requestId,
        ],
      );

      ctx.policies.invalidate();
      await ctx.cache.deletePrefix('search:');

      return { providerId, enabled: body.enabled };
    },
  );

  // --- Source health ------------------------------------------------------

  app.get(
    '/api/v1/admin/source-health',
    { preHandler: [...adminOnly, requirePermission('admin:providers')] },
    async (request) => {
      const hours = Number.parseInt((request.query as { hours?: string }).hours ?? '24', 10) || 24;
      return {
        live: ctx.health.all(),
        history: await ctx.health.history(hours),
        cache: ctx.cache.stats(),
        configuration: ctx.registry.map((entry) => ({
          providerId: entry.providerId,
          enabled: entry.configuration.enabled,
          fullyConfigured: entry.configuration.fullyConfigured,
          // Names of missing settings, never their values.
          missingSettings: entry.configuration.missing,
          servingDemoFixtures: entry.servingDemoFixtures,
        })),
      };
    },
  );

  // --- Analytics ----------------------------------------------------------

  app.get(
    '/api/v1/admin/analytics',
    { preHandler: [...adminOnly, requirePermission('admin:analytics')] },
    async (request) => {
      const hours = Number.parseInt((request.query as { hours?: string }).hours ?? '24', 10) || 24;
      const [search, events, clicks, terms] = await Promise.all([
        ctx.telemetry.searchMetrics(hours),
        ctx.telemetry.eventCounts(hours),
        ctx.affiliate.clickStats(hours),
        ctx.telemetry.topSearchTerms(25),
      ]);

      return {
        windowHours: hours,
        search,
        events,
        affiliate: clicks.map((entry) => ({
          ...entry,
          // Commission is not imported from any programme yet, and the
          // response says so rather than showing a number.
          estimatedCommission: null,
          commissionNote: 'Programme conversion reporting is not integrated (feature: PLANNED).',
        })),
        topSearchTerms: terms,
        note: 'Search terms come only from users who enabled search history, with terms appearing fewer than five times excluded.',
      };
    },
  );

  // --- Audit log ----------------------------------------------------------

  app.get(
    '/api/v1/admin/audit',
    { preHandler: [...adminOnly, requirePermission('admin:audit_log')] },
    async (request) => {
      const limit = Math.min(
        Number.parseInt((request.query as { limit?: string }).limit ?? '100', 10) || 100,
        500,
      );
      const result = await ctx.db.query(
        `SELECT entry_id, actor_email, action, subject_type, subject_id,
                before, after, reason, created_at
           FROM audit_logs
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit],
      );
      return { entries: result.rows };
    },
  );

  app.get(
    '/api/v1/admin/compliance-events',
    { preHandler: [...adminOnly, requirePermission('admin:compliance')] },
    async (request) => {
      const query = request.query as { limit?: string; severity?: string };
      const limit = Math.min(Number.parseInt(query.limit ?? '100', 10) || 100, 500);
      const result = await ctx.db.query(
        `SELECT event_id, kind, provider_id, capability, severity,
                policy_version, detail, created_at
           FROM compliance_events
          WHERE ($2::text IS NULL OR severity = $2)
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit, query.severity ?? null],
      );
      return { events: result.rows };
    },
  );

  /**
   * Product debugger: the raw provider payload beside the normalized view and
   * the match evidence. Admin-only, and the raw payload is returned only for
   * providers whose policy permits us to hold it at all.
   */
  app.get(
    '/api/v1/admin/debug/product/:providerId/:providerProductId',
    { preHandler: [...adminOnly, requirePermission('admin:debug_product')] },
    async (request) => {
      const { providerId, providerProductId } = request.params as {
        providerId: string;
        providerProductId: string;
      };

      const guard = await ctx.guards.forProvider(providerId, 'en');
      const stored = await ctx.db.query(
        `SELECT product_source_id, title, raw_title, brand, gtin, mpn, model,
                variant_key, variant_attributes, specifications,
                stored_under_policy, data_origin, first_seen_at, last_seen_at,
                CASE WHEN $3 THEN raw_payload ELSE NULL END AS raw_payload
           FROM product_sources
          WHERE provider_id = $1 AND provider_product_id = $2`,
        [providerId, providerProductId, guard.persistencePermitted()],
      );

      return {
        providerId,
        providerProductId,
        policyVersion: guard.policyVersion,
        persistencePermitted: guard.persistencePermitted(),
        rawPayloadWithheldReason: guard.persistencePermitted()
          ? null
          : 'This provider’s policy does not permit retaining its responses, so there is no stored payload to show.',
        stored: stored.rows[0] ?? null,
        capabilities: guard.matrix(),
        cacheSecondsPermitted: guard.maxCacheSeconds(),
        retentionSecondsPermitted: guard.maxRetentionSeconds(),
      };
    },
  );
}
