import { AmazonAdapter } from './amazon/index.js';
import { AliExpressAdapter } from './aliexpress/index.js';
import { TemuAdapter } from './temu/index.js';
import { DemoFixtureAdapter } from './fixtures/demo-adapter.js';
import {
  type ConfigDescription,
  type IntegrationsConfig,
  describeAliExpressConfig,
  describeAmazonConfig,
  describeTemuConfig,
} from './common/config.js';
import type { ProviderAdapter } from './common/adapter.js';

/**
 * Adapter registry.
 *
 * Builds the set of adapters from configuration. A provider with no
 * credentials gets either the demo fixture adapter (when fixtures are allowed)
 * or its real adapter in a NOT_CONFIGURED state — never a silently empty one,
 * because "no results" and "not set up" must look different to the user and in
 * the admin console.
 *
 * Adding a provider is a one-line change here plus a policy record. The search
 * engine, matcher and pricing engine are untouched (rules 258, 259).
 */

export interface RegistryEntry {
  readonly providerId: string;
  readonly adapter: ProviderAdapter;
  readonly configuration: ConfigDescription;
  /** True when this entry is serving labelled fixtures rather than live data. */
  readonly servingDemoFixtures: boolean;
}

export function buildAdapterRegistry(config: IntegrationsConfig): ReadonlyArray<RegistryEntry> {
  const timeouts = {
    requestTimeoutMs: config.requestTimeoutMs,
    rateLimitWaitMs: config.rateLimitWaitMs,
  };

  const entries: RegistryEntry[] = [];

  // --- Amazon -------------------------------------------------------------
  const amazonConfiguration = describeAmazonConfig(config.amazon);
  entries.push(
    makeEntry({
      providerId: 'amazon',
      live: () => new AmazonAdapter(config.amazon, timeouts),
      configuration: amazonConfiguration,
      allowDemoFixtures: config.allowDemoFixtures,
    }),
  );

  // --- AliExpress ---------------------------------------------------------
  const aliexpressConfiguration = describeAliExpressConfig(config.aliexpress);
  entries.push(
    makeEntry({
      providerId: 'aliexpress',
      live: () => new AliExpressAdapter(config.aliexpress, timeouts),
      configuration: aliexpressConfiguration,
      allowDemoFixtures: config.allowDemoFixtures,
    }),
  );

  // --- Temu ---------------------------------------------------------------
  const temuConfiguration = describeTemuConfig(config.temu);
  entries.push(
    makeEntry({
      providerId: 'temu',
      live: () => new TemuAdapter(config.temu, timeouts),
      configuration: temuConfiguration,
      allowDemoFixtures: config.allowDemoFixtures,
    }),
  );

  return entries;
}

function makeEntry(args: {
  readonly providerId: string;
  readonly live: () => ProviderAdapter;
  readonly configuration: ConfigDescription;
  readonly allowDemoFixtures: boolean;
}): RegistryEntry {
  const usable = args.configuration.enabled && args.configuration.fullyConfigured;

  if (usable) {
    return {
      providerId: args.providerId,
      adapter: args.live(),
      configuration: args.configuration,
      servingDemoFixtures: false,
    };
  }

  if (args.allowDemoFixtures) {
    return {
      providerId: args.providerId,
      adapter: new DemoFixtureAdapter(args.providerId),
      configuration: args.configuration,
      servingDemoFixtures: true,
    };
  }

  // Real adapter, which will refuse every operation with
  // ERROR_SOURCE_NOT_CONFIGURED. The user is told the source is unavailable
  // rather than shown an empty result set.
  return {
    providerId: args.providerId,
    adapter: args.live(),
    configuration: args.configuration,
    servingDemoFixtures: false,
  };
}

export function findAdapter(
  registry: ReadonlyArray<RegistryEntry>,
  providerId: string,
): RegistryEntry | undefined {
  return registry.find((entry) => entry.providerId === providerId);
}

/**
 * Identifies which provider a pasted URL belongs to by asking each adapter.
 * Pure string work, no network calls — so the URL analyzer can tell the user
 * what they pasted before deciding whether it can fetch anything about it.
 */
export function recognizeProductUrl(
  registry: ReadonlyArray<RegistryEntry>,
  url: string,
):
  | {
      readonly recognized: true;
      readonly providerId: string;
      readonly providerProductId: string;
      readonly variantId?: string;
    }
  | { readonly recognized: false; readonly reason: 'UNKNOWN_HOST' | 'NO_PRODUCT_ID' } {
  let sawMatchingHost = false;

  for (const entry of registry) {
    const result = entry.adapter.recognizeUrl(url);
    if (result.recognized) {
      return {
        recognized: true,
        providerId: entry.providerId,
        providerProductId: result.providerProductId,
        ...(result.variantId === undefined ? {} : { variantId: result.variantId }),
      };
    }
    if (result.reason === 'NO_PRODUCT_ID_IN_URL') sawMatchingHost = true;
  }

  return { recognized: false, reason: sawMatchingHost ? 'NO_PRODUCT_ID' : 'UNKNOWN_HOST' };
}
