import type { Capability, CapabilityState } from '../capabilities.js';
import type { ProviderId } from './provider.js';

/**
 * The policy registry is the system's memory of what each programme permits.
 * It lives in the database, is versioned, and is editable by an operator
 * without a code change — because affiliate terms change on the provider's
 * schedule, not on our release schedule.
 *
 * Nothing in feature code may hardcode a provider's permissions. Rule 217.
 */
export interface PolicyRecord {
  readonly providerId: ProviderId;
  readonly policyVersion: string;
  readonly termsUrl: string | null;
  readonly policyUrl: string | null;
  readonly programmeName: string;

  readonly capabilityStates: Readonly<Record<Capability, CapabilityState>>;

  /** Disclosure text per locale, rendered near links and in the footer. */
  readonly requiredDisclosures: Readonly<Record<string, string>>;
  /** Where disclosure must appear for this programme. */
  readonly disclosurePlacements: ReadonlyArray<
    'FOOTER' | 'NEAR_LINK' | 'PRODUCT_PAGE' | 'SEARCH_RESULTS' | 'EMAIL'
  >;

  readonly brandingRules: {
    readonly logoUsePermitted: boolean;
    readonly logoAssetPath: string | null;
    readonly nameMustAppearAs: string;
    readonly mayImplyPartnership: boolean;
    readonly notes: string | null;
  };

  readonly dataRules: {
    /** Seconds we may cache provider responses. 0 means request-scoped only. */
    readonly maxCacheSeconds: number;
    /** Seconds we may retain observations in our own store. */
    readonly maxRetentionSeconds: number | null;
    /** Whether this provider's content may be used to train/tune a model. */
    readonly modelTrainingPermitted: boolean;
    /** Whether responses may be stored at all beyond the request. */
    readonly persistencePermitted: boolean;
    /** Whether offers may be shown next to another provider's offers. */
    readonly crossProviderDisplayPermitted: boolean;
  };

  readonly linkRules: {
    /** Only these hosts may appear as a link destination. */
    readonly allowedDestinationHosts: ReadonlyArray<string>;
    readonly requiredQueryParams: ReadonlyArray<string>;
    readonly forbiddenQueryParams: ReadonlyArray<string>;
    /** Whether we may route clicks through our own redirect endpoint. */
    readonly interstitialRedirectPermitted: boolean;
    readonly cloakingPermitted: false;
  };

  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly policyCheckedAt: string | null;
  readonly notes: string | null;
  readonly effectiveFrom: string;
  readonly supersededAt: string | null;
}

export type ComplianceEventKind =
  | 'CAPABILITY_BLOCKED'
  | 'CONTENT_USAGE_REJECTED'
  | 'DISCLOSURE_MISSING'
  | 'AFFILIATE_LINK_INVALID'
  | 'POLICY_VERSION_STALE'
  | 'CACHE_POLICY_VIOLATION_PREVENTED'
  | 'RETENTION_SWEEP'
  | 'KILL_SWITCH_ENGAGED'
  | 'KILL_SWITCH_RELEASED'
  | 'DEMO_FIXTURE_SERVED'
  | 'VERIFICATION_REQUIRED_SURFACED';

export interface ComplianceEvent {
  readonly eventId: string;
  readonly kind: ComplianceEventKind;
  readonly providerId: ProviderId | null;
  readonly capability: Capability | null;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly policyVersion: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/**
 * A kill switch is the operator's ability to withdraw one capability from one
 * provider immediately, without a deploy. Mandated by rule 200: if a programme
 * tells us to stop showing something, we stop showing it today.
 */
export interface KillSwitch {
  readonly providerId: ProviderId;
  readonly capability: Capability;
  readonly engaged: boolean;
  readonly engagedBy: string | null;
  readonly engagedAt: string | null;
  readonly reason: string | null;
}

export interface AuditLogEntry {
  readonly entryId: string;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly reason: string | null;
  readonly requestId: string | null;
  readonly createdAt: string;
}

/** Operator view: everything awaiting a human decision, per provider. */
export interface ComplianceStatusReport {
  readonly providerId: ProviderId;
  readonly policyVersion: string;
  readonly policyCheckedAt: string | null;
  readonly policyAgeDays: number | null;
  readonly policyStale: boolean;
  readonly capabilitiesNeedingVerification: ReadonlyArray<Capability>;
  readonly capabilitiesNotConfigured: ReadonlyArray<Capability>;
  readonly engagedKillSwitches: ReadonlyArray<Capability>;
  readonly disclosureConfigured: boolean;
  readonly openWarnings: number;
}

/**
 * How long a policy record may go unreviewed before the Compliance Center
 * raises it. Programme terms change without notice; 90 days is a working
 * default, and release QA requires a fresh check regardless (rule 255).
 */
export const POLICY_REVIEW_INTERVAL_DAYS = 90;
