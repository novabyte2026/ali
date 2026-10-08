'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ProvidersResponse } from '@/lib/api';

/**
 * Provider capability context.
 *
 * Shares the capability map so a component can ask "is this feature available
 * for this source" without its own request. The helpers below are the only way
 * components should make that decision — a component that checks a provider id
 * directly would be hardcoding a permission, which is the thing the whole
 * policy registry exists to prevent.
 */

interface ProvidersContextValue {
  readonly data: ProvidersResponse | null;
  /** Display name for a provider, as its programme requires it to be written. */
  name(providerId: string): string;
  names(): Readonly<Record<string, string>>;
  /** Resolved capability state, or null when unknown. */
  capability(providerId: string, capability: string): string | null;
  /** True only when a capability is AVAILABLE. */
  can(providerId: string, capability: string): boolean;
  searchableProviderIds(): ReadonlyArray<string>;
  isDemo(providerId: string): boolean;
}

const ProvidersContext = createContext<ProvidersContextValue | null>(null);

export function ProvidersProvider({
  value,
  children,
}: {
  readonly value: ProvidersResponse | null;
  readonly children: ReactNode;
}) {
  const context = useMemo<ProvidersContextValue>(() => {
    const byId = new Map((value?.providers ?? []).map((entry) => [entry.id, entry] as const));

    return {
      data: value,
      name: (providerId) => byId.get(providerId)?.branding.displayName ?? providerId,
      names: () => {
        const out: Record<string, string> = {};
        for (const [id, entry] of byId) out[id] = entry.branding.displayName;
        return out;
      },
      capability: (providerId, capability) =>
        byId.get(providerId)?.capabilities[capability] ?? null,
      // Unknown resolves to false: when we cannot tell, we do not offer the
      // feature. Offering one that then fails is worse than omitting it.
      can: (providerId, capability) =>
        byId.get(providerId)?.capabilities[capability] === 'AVAILABLE',
      searchableProviderIds: () => value?.searchableProviderIds ?? [],
      isDemo: (providerId) => byId.get(providerId)?.servingDemoFixtures ?? false,
    };
  }, [value]);

  return <ProvidersContext.Provider value={context}>{children}</ProvidersContext.Provider>;
}

export function useProviders(): ProvidersContextValue {
  const value = useContext(ProvidersContext);
  if (!value) throw new Error('useProviders must be used inside a ProvidersProvider');
  return value;
}
