import {
  type Capability,
  type CapabilityMatrix,
  type CapabilityVerdict,
  type ComplianceEventKind,
  type FeatureGateVerdict,
  type FeatureName,
  evaluateFeature,
  isCapabilityAllowed,
  newId,
} from '@shelf/shared';
import type { CapabilityGuard } from '@shelf/integrations';
import type { Database } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { PolicyRegistry, ResolvedProviderPolicy } from './policy-registry.js';

/**
 * The capability guard handed to adapters, and the feature gate used by the
 * API.
 *
 * This is the only implementation of the permission question in the system.
 * Adapters do not read policy; feature code does not check provider ids. Both
 * call through here, which means a policy change is a data change and a
 * capability refusal is recorded once, consistently, wherever it happens.
 *
 * Refusals are written to `compliance_events` asynchronously. They are
 * genuinely useful operationally — a sudden spike of CAPABILITY_BLOCKED on one
 * provider is how you find out a kill switch was left engaged — but a logging
 * failure must never fail the request that triggered it, so writes are
 * fire-and-forget with their own error handling.
 */

export class ComplianceGuardFactory {
  /**
   * Per-request dedupe of event writes. A single search checks `productImages`
   * for every item from every provider; recording one row per check would
   * write thousands of identical events per minute and tell an operator
   * nothing extra.
   */
  private readonly recentlyRecorded = new Map<string, number>();

  constructor(
    private readonly registry: PolicyRegistry,
    private readonly db: Database,
    private readonly log: Logger,
  ) {}

  async forProvider(providerId: string, locale: string): Promise<ProviderGuard> {
    const resolved = await this.registry.forProvider(providerId);
    return new ProviderGuard(resolved, locale, this);
  }

  /** Guards for every provider named, resolved in one pass. */
  async forProviders(
    providerIds: ReadonlyArray<string>,
    locale: string,
  ): Promise<ReadonlyMap<string, ProviderGuard>> {
    const all = await this.registry.all();
    const index = new Map(all.map((entry) => [entry.providerId, entry] as const));
    const out = new Map<string, ProviderGuard>();
    for (const providerId of providerIds) {
      const resolved = index.get(providerId);
      if (resolved) out.set(providerId, new ProviderGuard(resolved, locale, this));
    }
    return out;
  }

  /**
   * Whether a user-facing feature may be offered for a provider. Used so the
   * UI never renders a control that would fail when clicked, and so the API
   * can refuse with an explanation rather than a generic error.
   */
  async featureVerdict(feature: FeatureName, providerId: string): Promise<FeatureGateVerdict> {
    const resolved = await this.registry.forProvider(providerId);
    return evaluateFeature(feature, providerId, resolved.effective);
  }

  /** Providers for which a feature is currently offerable. */
  async providersSupporting(feature: FeatureName): Promise<ReadonlyArray<string>> {
    const all = await this.registry.all();
    return all
      .filter((resolved) => evaluateFeature(feature, resolved.providerId, resolved.effective).enabled)
      .map((resolved) => resolved.providerId);
  }

  record(
    kind: ComplianceEventKind,
    args: {
      readonly providerId: string | null;
      readonly capability: Capability | null;
      readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
      readonly policyVersion: string | null;
      readonly detail?: Record<string, unknown>;
      readonly requestId?: string;
    },
  ): void {
    const dedupeKey = `${kind}:${args.providerId ?? '-'}:${args.capability ?? '-'}`;
    const now = Date.now();
    const last = this.recentlyRecorded.get(dedupeKey);
    // One row per kind/provider/capability per minute is plenty to spot a
    // pattern, and keeps a hot search path from writing thousands.
    if (last !== undefined && now - last < 60_000) return;
    this.recentlyRecorded.set(dedupeKey, now);

    if (this.recentlyRecorded.size > 2000) {
      for (const [key, at] of this.recentlyRecorded) {
        if (now - at > 300_000) this.recentlyRecorded.delete(key);
      }
    }

    void this.db
      .query(
        `INSERT INTO compliance_events
           (event_id, kind, provider_id, capability, severity, policy_version, detail, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newId('ce'),
          kind,
          args.providerId,
          args.capability,
          args.severity,
          args.policyVersion,
          JSON.stringify(args.detail ?? {}),
          args.requestId ?? null,
        ],
      )
      .catch((error: unknown) => {
        this.log.warn('Failed to record compliance event', { kind, error });
      });
  }
}

/**
 * Per-provider, per-locale guard. Cheap to construct; holds a snapshot of the
 * resolved policy so every check within one request sees a consistent view
 * even if an operator changes something mid-request.
 */
export class ProviderGuard implements CapabilityGuard {
  readonly policyVersion: string;

  constructor(
    private readonly resolved: ResolvedProviderPolicy,
    private readonly locale: string,
    private readonly factory: ComplianceGuardFactory,
    private readonly requestId?: string,
  ) {
    this.policyVersion = resolved.policy.policyVersion;
  }

  /** A copy bound to a request id, so refusals are attributable. */
  withRequestId(requestId: string): ProviderGuard {
    return new ProviderGuard(this.resolved, this.locale, this.factory, requestId);
  }

  check(capability: Capability): {
    allowed: boolean;
    state: string;
    policyVersion: string;
  } {
    const state = this.resolved.effective[capability];
    const allowed = isCapabilityAllowed(state);

    if (!allowed) {
      this.factory.record(
        state === 'VERIFICATION_REQUIRED'
          ? 'VERIFICATION_REQUIRED_SURFACED'
          : 'CAPABILITY_BLOCKED',
        {
          providerId: this.resolved.providerId,
          capability,
          // An unverified capability is an action item; a deliberate
          // restriction is routine and should not page anyone.
          severity: state === 'VERIFICATION_REQUIRED' ? 'WARNING' : 'INFO',
          policyVersion: this.policyVersion,
          detail: { state },
          ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
        },
      );
    }

    return { allowed, state, policyVersion: this.policyVersion };
  }

  verdict(capability: Capability): CapabilityVerdict {
    const state = this.resolved.effective[capability];
    return {
      capability,
      providerId: this.resolved.providerId,
      state,
      allowed: isCapabilityAllowed(state),
      policyVersion: this.policyVersion,
    };
  }

  matrix(): CapabilityMatrix {
    return this.resolved.effective;
  }

  declaredMatrix(): CapabilityMatrix {
    return this.resolved.declared;
  }

  maxCacheSeconds(): number {
    return this.resolved.policy.dataRules.maxCacheSeconds;
  }

  persistencePermitted(): boolean {
    return (
      this.resolved.policy.dataRules.persistencePermitted &&
      isCapabilityAllowed(this.resolved.effective.persistProviderData)
    );
  }

  /** Retention ceiling in seconds, or null when unbounded by policy. */
  maxRetentionSeconds(): number | null {
    return this.resolved.policy.dataRules.maxRetentionSeconds;
  }

  crossProviderDisplayPermitted(): boolean {
    return (
      this.resolved.policy.dataRules.crossProviderDisplayPermitted &&
      isCapabilityAllowed(this.resolved.effective.crossProviderComparison)
    );
  }

  modelTrainingPermitted(): boolean {
    return this.resolved.policy.dataRules.modelTrainingPermitted;
  }

  allowedDestinationHosts(): ReadonlyArray<string> {
    return this.resolved.policy.linkRules.allowedDestinationHosts;
  }

  forbiddenQueryParams(): ReadonlyArray<string> {
    return this.resolved.policy.linkRules.forbiddenQueryParams;
  }

  requiredQueryParams(): ReadonlyArray<string> {
    return this.resolved.policy.linkRules.requiredQueryParams;
  }

  /**
   * Programme disclosure text for a locale. Falls back to English, then to any
   * configured locale — a missing disclosure is recorded as a compliance
   * event, because a link that needs one and has none must be visible to an
   * operator rather than silently rendering without it.
   */
  disclosure(locale: string): string | null {
    const disclosures = this.resolved.policy.requiredDisclosures;
    const text = disclosures[locale] ?? disclosures.en ?? Object.values(disclosures)[0] ?? null;

    if (!text && this.resolved.policy.disclosurePlacements.includes('NEAR_LINK')) {
      this.factory.record('DISCLOSURE_MISSING', {
        providerId: this.resolved.providerId,
        capability: null,
        severity: 'CRITICAL',
        policyVersion: this.policyVersion,
        detail: { locale },
      });
    }

    return text;
  }

  disclosurePlacements(): ReadonlyArray<string> {
    return this.resolved.policy.disclosurePlacements;
  }

  brandingRules() {
    return this.resolved.policy.brandingRules;
  }

  get providerId(): string {
    return this.resolved.providerId;
  }

  get policy() {
    return this.resolved.policy;
  }

  get policyStale(): boolean {
    return this.resolved.policyStale;
  }

  /**
   * Cache TTL for a provider's data, never exceeding what its policy permits.
   * A zero means request-scoped only: the response may not be cached at all.
   */
  effectiveCacheSeconds(desiredSeconds: number): number {
    const ceiling = this.maxCacheSeconds();
    if (ceiling <= 0) return 0;
    return Math.min(desiredSeconds, ceiling);
  }

  /**
   * Whether a provider response may be written to our own store, and for how
   * long. Returns null when persistence is not permitted at all, which is what
   * keeps Amazon responses out of the catalog tables entirely.
   */
  retentionDeadline(now: Date = new Date()): Date | null {
    if (!this.persistencePermitted()) return null;
    const seconds = this.maxRetentionSeconds();
    if (seconds === null) return null;
    return new Date(now.getTime() + seconds * 1000);
  }
}
