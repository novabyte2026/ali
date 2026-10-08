import {
  type AffiliateLink,
  type LinkPlacement,
  type Principal,
  AppError,
  newId,
} from '@shelf/shared';
import {
  type AdapterContext,
  type RegistryEntry,
  isRefusal,
  validateAffiliateLink,
} from '@shelf/integrations';
import type { ComplianceGuardFactory } from '../compliance/guard.js';
import type { Database } from '../db/pool.js';
import type { Logger } from '../logger.js';

/**
 * Affiliate link generation and click recording.
 *
 * The link itself is built by the provider's adapter, because each programme
 * specifies its own format and some require a call to their own generator.
 * What this service adds is the parts that must be identical everywhere:
 *
 *   - Validation. Every link is checked against the provider's policy
 *     (destination host allowlist, forbidden parameters, disclosure present)
 *     before it is handed to a client. A link that fails is recorded as a
 *     compliance event and the plain store URL is served instead — the user
 *     still gets where they were going.
 *   - Click recording. Against a rotating session hash, with the user id only
 *     when one exists. Stored separately from analytics, which is what lets
 *     the two have different retention.
 *   - Disclosure. Resolved from the policy registry per provider and per
 *     locale, and returned alongside the link so the UI cannot render the
 *     button without having the disclosure text available.
 */

export interface AffiliateService {
  buildLink(args: {
    readonly providerId: string;
    readonly providerProductId: string;
    readonly destinationUrl: string;
    readonly placement: LinkPlacement;
    readonly locale: string;
    readonly countryCode: string;
    readonly requestId: string;
  }): Promise<AffiliateLink & { readonly disclosureText: string | null }>;

  recordClick(args: {
    readonly link: AffiliateLink;
    readonly principal: Principal;
    readonly productGroupId: string | null;
    readonly providerProductId: string | null;
    readonly countryCode: string | null;
    readonly deviceType: 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN';
  }): Promise<string>;

  clickStats(
    hours: number,
  ): Promise<ReadonlyArray<{
    readonly providerId: string;
    readonly clicks: number;
    readonly uniqueSessions: number;
    readonly untrackedClicks: number;
  }>>;
}

export function createAffiliateService(
  db: Database,
  registry: ReadonlyArray<RegistryEntry>,
  guards: ComplianceGuardFactory,
  log: Logger,
): AffiliateService {
  return {
    async buildLink(args) {
      const entry = registry.find((candidate) => candidate.providerId === args.providerId);
      if (!entry) {
        throw new AppError('ERROR_UNSUPPORTED_SOURCE', { details: { providerId: args.providerId } });
      }

      const guard = (await guards.forProvider(args.providerId, args.locale)).withRequestId(
        args.requestId,
      );

      const ctx: AdapterContext = {
        guard,
        countryCode: args.countryCode,
        currency: 'USD',
        locale: args.locale,
        requestId: args.requestId,
        signal: AbortSignal.timeout(5000),
        log: log.child({ providerId: args.providerId }),
      };

      const outcome = await entry.adapter.buildAffiliateLink(
        {
          destinationUrl: args.destinationUrl,
          providerProductId: args.providerProductId,
          placement: args.placement,
          trackingId: null,
          campaignId: null,
        },
        ctx,
      );

      if (!outcome.ok) {
        if (isRefusal(outcome)) {
          throw new AppError('ERROR_CAPABILITY_UNAVAILABLE', {
            details: { capability: outcome.refusal.capability, providerId: args.providerId },
          });
        }
        throw new AppError('ERROR_INVALID_AFFILIATE_LINK', {
          internalNote: outcome.failure.internalNote,
        });
      }

      const link = outcome.value;
      const validation = validateAffiliateLink(link, guard);

      if (!validation.valid) {
        guards.record('AFFILIATE_LINK_INVALID', {
          providerId: args.providerId,
          capability: 'affiliateLinks',
          severity: 'CRITICAL',
          policyVersion: guard.policyVersion,
          detail: { problems: validation.problems, placement: args.placement },
          requestId: args.requestId,
        });

        log.error('Affiliate link failed validation', {
          providerId: args.providerId,
          problems: validation.problems,
        });

        // A link we cannot vouch for is not served. The user still reaches the
        // store; we simply earn nothing from this click.
        if (
          validation.problems.some(
            (problem) =>
              problem.startsWith('AFFILIATE_HOST') ||
              problem.startsWith('FORBIDDEN_PARAM') ||
              problem === 'AFFILIATE_URL_NOT_HTTPS',
          )
        ) {
          return {
            ...link,
            affiliateUrl: link.destinationUrl,
            trackingId: null,
            status: 'INVALID',
            disclosureText: guard.disclosure(args.locale),
          };
        }
      }

      return { ...link, disclosureText: guard.disclosure(args.locale) };
    },

    async recordClick(args) {
      const clickId = newId('clk');
      const sessionHash =
        args.principal.kind === 'user'
          ? `user:${args.principal.userId}`
          : args.principal.sessionHash;

      try {
        await db.query(
          `INSERT INTO affiliate_clicks
             (click_id, provider_id, user_id, session_hash, product_group_id,
              provider_product_id, placement, country_code, device_type,
              campaign_id, tracking_id, destination_host, link_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            clickId,
            args.link.providerId,
            args.principal.kind === 'user' ? args.principal.userId : null,
            sessionHash,
            args.productGroupId,
            args.providerProductId,
            args.link.placement,
            args.countryCode,
            args.deviceType,
            args.link.campaignId,
            args.link.trackingId,
            args.link.destinationHost,
            args.link.status,
          ],
        );
      } catch (error) {
        // A failed click record must not stop the user navigating.
        log.warn('Affiliate click record failed', { providerId: args.link.providerId, error });
      }

      return clickId;
    },

    async clickStats(hours) {
      const result = await db.query<{
        provider_id: string;
        clicks: string;
        unique_sessions: string;
        untracked: string;
      }>(
        `SELECT provider_id,
                count(*)::text AS clicks,
                count(DISTINCT session_hash)::text AS unique_sessions,
                count(*) FILTER (WHERE tracking_id IS NULL)::text AS untracked
           FROM affiliate_clicks
          WHERE created_at > now() - ($1 || ' hours')::interval
          GROUP BY provider_id
          ORDER BY count(*) DESC`,
        [String(Math.max(1, Math.min(hours, 8760)))],
      );

      return result.rows.map((row) => ({
        providerId: row.provider_id,
        clicks: Number.parseInt(row.clicks, 10),
        uniqueSessions: Number.parseInt(row.unique_sessions, 10),
        // Worth watching: a rising untracked count means a programme's link
        // generation is failing and commission is being lost silently.
        untrackedClicks: Number.parseInt(row.untracked, 10),
      }));
    },
  };
}
