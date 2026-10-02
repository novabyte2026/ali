/**
 * Provider credential configuration.
 *
 * Read from the environment by the backend and handed to adapters at
 * construction. Credentials never appear in the database, never reach the
 * frontend bundle, and are never logged — `describeConfig` below exists so the
 * admin console can report what is configured without revealing any value.
 */

export interface AmazonConfig {
  readonly enabled: boolean;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly partnerTag: string;
  readonly host: string;
  readonly region: string;
  readonly marketplace: string;
  readonly defaultCountry: string;
  readonly rateLimitRps: number;
  readonly rateLimitBurst: number;
}

export interface AliExpressConfig {
  readonly enabled: boolean;
  readonly appKey: string;
  readonly appSecret: string;
  readonly gateway: string;
  readonly trackingId: string;
  readonly defaultCountry: string;
  readonly rateLimitRps: number;
  readonly rateLimitBurst: number;
}

export interface TemuConfig {
  readonly enabled: boolean;
  /**
   * Empty until a programme contract establishes the endpoint. The adapter
   * treats an empty base URL as NOT_CONFIGURED and refuses every operation
   * rather than guessing a URL shape.
   */
  readonly apiBaseUrl: string;
  readonly appKey: string;
  readonly appSecret: string;
  readonly affiliateId: string;
  readonly defaultCountry: string;
  readonly rateLimitRps: number;
  readonly rateLimitBurst: number;
}

export interface IntegrationsConfig {
  readonly amazon: AmazonConfig;
  readonly aliexpress: AliExpressConfig;
  readonly temu: TemuConfig;
  /** When true, unconfigured providers serve clearly-labelled fixtures. */
  readonly allowDemoFixtures: boolean;
  /** Per-provider wall-clock budget for one call. */
  readonly requestTimeoutMs: number;
  /** How long a search will wait on a rate-limited provider before skipping. */
  readonly rateLimitWaitMs: number;
}

export interface ConfigDescription {
  readonly providerId: string;
  readonly enabled: boolean;
  /** Which required settings are present. Values are never included. */
  readonly present: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
  readonly fullyConfigured: boolean;
}

export function describeAmazonConfig(config: AmazonConfig): ConfigDescription {
  const required: ReadonlyArray<[string, string]> = [
    ['AMAZON_ACCESS_KEY', config.accessKey],
    ['AMAZON_SECRET_KEY', config.secretKey],
    ['AMAZON_PARTNER_TAG', config.partnerTag],
    ['AMAZON_HOST', config.host],
    ['AMAZON_REGION', config.region],
    ['AMAZON_MARKETPLACE', config.marketplace],
  ];
  return describe('amazon', config.enabled, required);
}

export function describeAliExpressConfig(config: AliExpressConfig): ConfigDescription {
  const required: ReadonlyArray<[string, string]> = [
    ['ALIEXPRESS_APP_KEY', config.appKey],
    ['ALIEXPRESS_APP_SECRET', config.appSecret],
    ['ALIEXPRESS_GATEWAY', config.gateway],
    ['ALIEXPRESS_TRACKING_ID', config.trackingId],
  ];
  return describe('aliexpress', config.enabled, required);
}

export function describeTemuConfig(config: TemuConfig): ConfigDescription {
  const required: ReadonlyArray<[string, string]> = [
    ['TEMU_API_BASE_URL', config.apiBaseUrl],
    ['TEMU_APP_KEY', config.appKey],
    ['TEMU_APP_SECRET', config.appSecret],
    ['TEMU_AFFILIATE_ID', config.affiliateId],
  ];
  return describe('temu', config.enabled, required);
}

function describe(
  providerId: string,
  enabled: boolean,
  required: ReadonlyArray<[string, string]>,
): ConfigDescription {
  const present: string[] = [];
  const missing: string[] = [];
  for (const [name, value] of required) {
    if (value && value.trim().length > 0) present.push(name);
    else missing.push(name);
  }
  return {
    providerId,
    enabled,
    present,
    missing,
    fullyConfigured: missing.length === 0,
  };
}
