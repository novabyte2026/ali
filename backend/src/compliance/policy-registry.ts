import {
  type Capability,
  type CapabilityMatrix,
  type CapabilityState,
  type PolicyRecord,
  AppError,
  CAPABILITIES,
  POLICY_REVIEW_INTERVAL_DAYS,
  emptyMatrix,
  isCapability,
} from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { Logger } from '../logger.js';

/**
 * The policy registry.
 *
 * Loads the in-force policy and capability states for every provider from the
 * database and keeps them in memory with a short TTL. Everything that asks
 * "may we do X with provider Y's data" resolves through here, so there is
 * exactly one answer in the process and one place to change it.
 *
 * Why in-memory with a TTL rather than a query per check: a single search
 * performs hundreds of capability checks across three providers, and a
 * database round trip per field would dominate the request. The TTL is short
 * (30 seconds) and `invalidate()` is called whenever an operator changes a
 * policy or engages a kill switch, so an operator action takes effect
 * immediately rather than within the TTL.
 */

const CACHE_TTL_MS = 30_000;

export interface ResolvedProviderPolicy {
  readonly providerId: string;
  readonly policy: PolicyRecord;
  /**
   * Final capability states: policy state, narrowed by whether credentials
   * exist and by any engaged kill switch. This is what the guard reads.
   */
  readonly effective: CapabilityMatrix;
  /** Policy state before configuration and kill switches, for the admin UI. */
  readonly declared: CapabilityMatrix;
  readonly killSwitches: ReadonlyArray<Capability>;
  readonly providerEnabled: boolean;
  readonly policyAgeDays: number | null;
  readonly policyStale: boolean;
}

interface CacheEntry {
  readonly loadedAt: number;
  readonly byProvider: ReadonlyMap<string, ResolvedProviderPolicy>;
}

export interface ConfiguredCapabilityLookup {
  (providerId: string): Readonly<Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>> | undefined;
}

export class PolicyRegistry {
  private cache: CacheEntry | null = null;
  private inFlight: Promise<CacheEntry> | null = null;

  constructor(
    private readonly db: Database,
    private readonly log: Logger,
    /**
     * Supplies, per provider, whether each capability's credentials are
     * present. Injected from the adapter registry rather than read here,
     * because only the adapter knows what it needs.
     */
    private readonly configuredCapabilities: ConfiguredCapabilityLookup,
  ) {}

  /** Drops the cache. Called after any operator change. */
  invalidate(): void {
    this.cache = null;
  }

  async all(): Promise<ReadonlyArray<ResolvedProviderPolicy>> {
    const entry = await this.load();
    return [...entry.byProvider.values()];
  }

  async forProvider(providerId: string): Promise<ResolvedProviderPolicy> {
    const entry = await this.load();
    const resolved = entry.byProvider.get(providerId);
    if (!resolved) {
      throw new AppError('ERROR_UNSUPPORTED_SOURCE', { details: { providerId } });
    }
    return resolved;
  }

  async providerIds(): Promise<ReadonlyArray<string>> {
    const entry = await this.load();
    return [...entry.byProvider.keys()];
  }

  /**
   * Providers that may be queried right now: enabled, with a policy in force,
   * and with `search` actually available. This is what `all` mode resolves to,
   * so a provider pending verification is genuinely excluded rather than
   * queried and then filtered.
   */
  async searchableProviderIds(): Promise<ReadonlyArray<string>> {
    const entry = await this.load();
    return [...entry.byProvider.values()]
      .filter((resolved) => resolved.providerEnabled && resolved.effective.search === 'AVAILABLE')
      .map((resolved) => resolved.providerId);
  }

  private async load(): Promise<CacheEntry> {
    const now = Date.now();
    if (this.cache && now - this.cache.loadedAt < CACHE_TTL_MS) return this.cache;

    // Coalesce concurrent loads: a burst of parallel searches on a cold cache
    // must not produce one query per search.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.loadFromDatabase()
      .then((entry) => {
        this.cache = entry;
        return entry;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async loadFromDatabase(): Promise<CacheEntry> {
    const providers = await this.db.query<ProviderRow>(
      `SELECT provider_id, display_name, programme_name, enabled, countries,
              default_country, currencies, market_hosts, sort_order
         FROM providers
        ORDER BY sort_order DESC, provider_id`,
    );

    const policies = await this.db.query<PolicyRow>(
      `SELECT policy_id, provider_id, policy_version, terms_url, policy_url,
              required_disclosures, disclosure_placements,
              logo_use_permitted, logo_asset_path, name_must_appear_as,
              may_imply_partnership, branding_notes,
              max_cache_seconds, max_retention_seconds, model_training_permitted,
              persistence_permitted, cross_provider_display_permitted,
              allowed_destination_hosts, required_query_params, forbidden_query_params,
              interstitial_redirect_permitted,
              reviewed_by, reviewed_at, policy_checked_at, notes,
              effective_from
         FROM provider_policies
        WHERE superseded_at IS NULL`,
    );

    const capabilities = await this.db.query<CapabilityRow>(
      `SELECT pc.provider_id, pc.policy_id, pc.capability, pc.state, pc.rationale
         FROM provider_capabilities pc
         JOIN provider_policies pp ON pp.policy_id = pc.policy_id
        WHERE pp.superseded_at IS NULL`,
    );

    const killSwitches = await this.db.query<KillSwitchRow>(
      `SELECT provider_id, capability
         FROM capability_kill_switches
        WHERE engaged = TRUE`,
    );

    const policyByProvider = new Map(policies.rows.map((row) => [row.provider_id, row]));
    const capabilityByPolicy = new Map<string, Map<string, CapabilityRow>>();
    for (const row of capabilities.rows) {
      const existing = capabilityByPolicy.get(row.policy_id) ?? new Map<string, CapabilityRow>();
      existing.set(row.capability, row);
      capabilityByPolicy.set(row.policy_id, existing);
    }

    const killByProvider = new Map<string, Set<string>>();
    for (const row of killSwitches.rows) {
      const existing = killByProvider.get(row.provider_id) ?? new Set<string>();
      existing.add(row.capability);
      killByProvider.set(row.provider_id, existing);
    }

    const byProvider = new Map<string, ResolvedProviderPolicy>();

    for (const providerRow of providers.rows) {
      const policyRow = policyByProvider.get(providerRow.provider_id);
      if (!policyRow) {
        // A provider with no policy in force is unusable by construction. We
        // surface it as fully restricted rather than defaulting to permissive.
        this.log.warn('Provider has no policy in force; treating as fully restricted', {
          providerId: providerRow.provider_id,
        });
        byProvider.set(providerRow.provider_id, {
          providerId: providerRow.provider_id,
          policy: fallbackPolicy(providerRow),
          declared: emptyMatrix('NOT_PERMITTED'),
          effective: emptyMatrix('NOT_PERMITTED'),
          killSwitches: [],
          providerEnabled: false,
          policyAgeDays: null,
          policyStale: true,
        });
        continue;
      }

      const declared = buildDeclaredMatrix(capabilityByPolicy.get(policyRow.policy_id));
      const engaged = killByProvider.get(providerRow.provider_id) ?? new Set<string>();
      const configured = this.configuredCapabilities(providerRow.provider_id);

      const effective = narrowMatrix({
        declared,
        providerEnabled: providerRow.enabled,
        engagedKillSwitches: engaged,
        configured,
      });

      const policyAgeDays = policyRow.policy_checked_at
        ? Math.floor((Date.now() - policyRow.policy_checked_at.getTime()) / 86_400_000)
        : null;

      byProvider.set(providerRow.provider_id, {
        providerId: providerRow.provider_id,
        policy: toPolicyRecord(providerRow, policyRow),
        declared,
        effective,
        killSwitches: [...engaged].filter(isCapability),
        providerEnabled: providerRow.enabled,
        policyAgeDays,
        // Never reviewed counts as stale: an unreviewed policy is exactly the
        // thing the Compliance Center exists to surface.
        policyStale: policyAgeDays === null || policyAgeDays > POLICY_REVIEW_INTERVAL_DAYS,
      });
    }

    return { loadedAt: Date.now(), byProvider };
  }
}

/**
 * Narrows a declared capability state by runtime reality.
 *
 * Order matters and is deliberately most-restrictive-wins:
 *   1. Provider disabled by an operator  -> DISABLED_BY_OPERATOR for everything.
 *   2. Kill switch engaged               -> DISABLED_BY_OPERATOR.
 *   3. Policy says not permitted / needs verification -> keep that answer.
 *   4. Policy permits but credentials absent -> NOT_CONFIGURED.
 *
 * Step 3 before step 4 is the important one: a capability we are not permitted
 * to use should read as not permitted even when credentials happen to be
 * missing too, because the fix is a legal review and not a deployment change.
 */
export function narrowMatrix(args: {
  readonly declared: CapabilityMatrix;
  readonly providerEnabled: boolean;
  readonly engagedKillSwitches: ReadonlySet<string>;
  readonly configured: Readonly<Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>> | undefined;
}): CapabilityMatrix {
  const out = {} as Record<Capability, CapabilityState>;

  for (const capability of CAPABILITIES) {
    const declared = args.declared[capability];

    if (!args.providerEnabled) {
      out[capability] = 'DISABLED_BY_OPERATOR';
      continue;
    }
    if (args.engagedKillSwitches.has(capability)) {
      out[capability] = 'DISABLED_BY_OPERATOR';
      continue;
    }
    if (declared !== 'AVAILABLE') {
      out[capability] = declared;
      continue;
    }
    if (args.configured && args.configured[capability] === 'NOT_CONFIGURED') {
      out[capability] = 'NOT_CONFIGURED';
      continue;
    }
    out[capability] = 'AVAILABLE';
  }

  return out;
}

function buildDeclaredMatrix(rows: Map<string, CapabilityRow> | undefined): CapabilityMatrix {
  const out = {} as Record<Capability, CapabilityState>;
  for (const capability of CAPABILITIES) {
    // A capability with no row has not been reviewed, which is
    // VERIFICATION_REQUIRED and not AVAILABLE. Defaulting the other way is how
    // a new capability silently goes live everywhere.
    out[capability] = (rows?.get(capability)?.state as CapabilityState) ?? 'VERIFICATION_REQUIRED';
  }
  return out;
}

function toPolicyRecord(providerRow: ProviderRow, row: PolicyRow): PolicyRecord {
  return {
    providerId: row.provider_id,
    policyVersion: row.policy_version,
    termsUrl: row.terms_url,
    policyUrl: row.policy_url,
    programmeName: providerRow.programme_name,
    capabilityStates: emptyMatrix(),
    requiredDisclosures: (row.required_disclosures ?? {}) as Record<string, string>,
    disclosurePlacements: (row.disclosure_placements ?? []) as PolicyRecord['disclosurePlacements'],
    brandingRules: {
      logoUsePermitted: row.logo_use_permitted,
      logoAssetPath: row.logo_asset_path,
      nameMustAppearAs: row.name_must_appear_as,
      mayImplyPartnership: row.may_imply_partnership,
      notes: row.branding_notes,
    },
    dataRules: {
      maxCacheSeconds: row.max_cache_seconds,
      maxRetentionSeconds: row.max_retention_seconds,
      modelTrainingPermitted: row.model_training_permitted,
      persistencePermitted: row.persistence_permitted,
      crossProviderDisplayPermitted: row.cross_provider_display_permitted,
    },
    linkRules: {
      allowedDestinationHosts: row.allowed_destination_hosts ?? [],
      requiredQueryParams: row.required_query_params ?? [],
      forbiddenQueryParams: row.forbidden_query_params ?? [],
      interstitialRedirectPermitted: row.interstitial_redirect_permitted,
      cloakingPermitted: false,
    },
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    policyCheckedAt: row.policy_checked_at?.toISOString() ?? null,
    notes: row.notes,
    effectiveFrom: row.effective_from.toISOString(),
    supersededAt: null,
  };
}

function fallbackPolicy(providerRow: ProviderRow): PolicyRecord {
  return {
    providerId: providerRow.provider_id,
    policyVersion: 'none',
    termsUrl: null,
    policyUrl: null,
    programmeName: providerRow.programme_name,
    capabilityStates: emptyMatrix('NOT_PERMITTED'),
    requiredDisclosures: {},
    disclosurePlacements: [],
    brandingRules: {
      logoUsePermitted: false,
      logoAssetPath: null,
      nameMustAppearAs: providerRow.display_name,
      mayImplyPartnership: false,
      notes: null,
    },
    dataRules: {
      maxCacheSeconds: 0,
      maxRetentionSeconds: 0,
      modelTrainingPermitted: false,
      persistencePermitted: false,
      crossProviderDisplayPermitted: false,
    },
    linkRules: {
      allowedDestinationHosts: [],
      requiredQueryParams: [],
      forbiddenQueryParams: [],
      interstitialRedirectPermitted: false,
      cloakingPermitted: false,
    },
    reviewedBy: null,
    reviewedAt: null,
    policyCheckedAt: null,
    notes: 'No policy record in force. Treated as fully restricted.',
    effectiveFrom: new Date(0).toISOString(),
    supersededAt: null,
  };
}

interface ProviderRow {
  provider_id: string;
  display_name: string;
  programme_name: string;
  enabled: boolean;
  countries: string[];
  default_country: string;
  currencies: string[];
  market_hosts: Record<string, string>;
  sort_order: number;
}

interface PolicyRow {
  policy_id: string;
  provider_id: string;
  policy_version: string;
  terms_url: string | null;
  policy_url: string | null;
  required_disclosures: Record<string, string> | null;
  disclosure_placements: string[] | null;
  logo_use_permitted: boolean;
  logo_asset_path: string | null;
  name_must_appear_as: string;
  may_imply_partnership: boolean;
  branding_notes: string | null;
  max_cache_seconds: number;
  max_retention_seconds: number | null;
  model_training_permitted: boolean;
  persistence_permitted: boolean;
  cross_provider_display_permitted: boolean;
  allowed_destination_hosts: string[] | null;
  required_query_params: string[] | null;
  forbidden_query_params: string[] | null;
  interstitial_redirect_permitted: boolean;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  policy_checked_at: Date | null;
  notes: string | null;
  effective_from: Date;
}

interface CapabilityRow {
  provider_id: string;
  policy_id: string;
  capability: string;
  state: string;
  rationale: string | null;
}

interface KillSwitchRow {
  provider_id: string;
  capability: string;
}

export interface ProviderMarketInfo {
  readonly providerId: string;
  readonly displayName: string;
  readonly countries: ReadonlyArray<string>;
  readonly defaultCountry: string;
  readonly currencies: ReadonlyArray<string>;
  readonly marketHosts: Readonly<Record<string, string>>;
}

export async function loadProviderMarkets(db: Database): Promise<ReadonlyArray<ProviderMarketInfo>> {
  const result = await db.query<ProviderRow>(
    `SELECT provider_id, display_name, programme_name, enabled, countries,
            default_country, currencies, market_hosts, sort_order
       FROM providers
      ORDER BY sort_order DESC`,
  );
  return result.rows.map((row) => ({
    providerId: row.provider_id,
    displayName: row.display_name,
    countries: row.countries ?? [],
    defaultCountry: row.default_country,
    currencies: row.currencies ?? [],
    marketHosts: row.market_hosts ?? {},
  }));
}
