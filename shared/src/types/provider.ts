import type { CapabilityMatrix } from '../capabilities.js';

/**
 * A provider is one authorized marketplace source. The set is open: adding
 * eBay or Walmart later means adding an adapter and a config/policy record,
 * not touching the search engine.
 */
export type ProviderId = string;

/** The four entry routes offered on the homepage and in the header. */
export const SOURCE_MODES = ['all', 'temu', 'aliexpress', 'amazon'] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];

export function isSourceMode(value: string): value is SourceMode {
  return (SOURCE_MODES as readonly string[]).includes(value);
}

/**
 * Resolves a route to the providers it may query. `all` means "every provider
 * that is enabled, configured and permitted right now" — which is computed at
 * request time, not baked in here.
 */
export function providersForMode(
  mode: SourceMode,
  activeProviderIds: ReadonlyArray<ProviderId>,
): ProviderId[] {
  if (mode === 'all') return [...activeProviderIds];
  return activeProviderIds.filter((id) => id === mode);
}

export type ProviderRuntimeState =
  | 'ACTIVE'
  | 'NOT_CONFIGURED'
  | 'DISABLED_BY_OPERATOR'
  | 'DEGRADED'
  | 'UNAVAILABLE';

export interface ProviderBranding {
  /** Display name exactly as the provider requires it to be written. */
  readonly displayName: string;
  /**
   * Whether we hold permission to render the provider's logo. When false the
   * UI uses a neutral text badge — it does not substitute a lookalike mark.
   */
  readonly logoPermitted: boolean;
  /** Path to the approved asset, served from our own origin. */
  readonly logoAssetPath: string | null;
  /** Required legal wording for referring to the brand, if any. */
  readonly attributionNotice: string | null;
}

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly branding: ProviderBranding;
  /** Markets this provider is wired up for, as ISO 3166-1 alpha-2 codes. */
  readonly countries: ReadonlyArray<string>;
  readonly defaultCountry: string;
  /** Currencies the provider reports prices in, per market. */
  readonly currencies: ReadonlyArray<string>;
  readonly capabilities: CapabilityMatrix;
  readonly runtimeState: ProviderRuntimeState;
  /** Policy registry version these capabilities were resolved against. */
  readonly policyVersion: string;
  /** True when this provider is currently serving labelled demo fixtures. */
  readonly servingDemoFixtures: boolean;
}

export interface ProviderHealth {
  readonly providerId: ProviderId;
  readonly runtimeState: ProviderRuntimeState;
  readonly successRate1h: number | null;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorCode: string | null;
  readonly circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly rateLimit: {
    readonly requestsPerSecond: number;
    readonly burst: number;
    readonly currentlyThrottled: boolean;
  };
}

/** Per-request outcome for one provider, surfaced as "2 of 3 sources". */
export interface ProviderAttempt {
  readonly providerId: ProviderId;
  readonly status: 'PENDING' | 'RUNNING' | 'OK' | 'EMPTY' | 'FAILED' | 'SKIPPED';
  readonly durationMs: number | null;
  readonly resultCount: number;
  /** Error code when status is FAILED, or skip reason when SKIPPED. */
  readonly reason: string | null;
}
