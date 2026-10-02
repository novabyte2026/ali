'use client';

import { SOURCE_MODES, type SourceMode } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import styles from './SourceTabs.module.css';

/**
 * The four source routes.
 *
 * A route with no source that can answer is rendered but labelled, rather than
 * removed. The four routes are the shape of the product; silently dropping one
 * would leave a user wondering where Temu went, whereas "pending verification"
 * is an answer.
 *
 * Switching does not reload. The query, country and currency are preserved and
 * only the source changes, which is what makes the tabs feel like a filter on
 * one search rather than four separate products.
 */

export interface SourceTabState {
  readonly mode: SourceMode;
  readonly available: boolean;
  /** Translation-resolved reason when unavailable. */
  readonly note: string | null;
  readonly resultCount?: number;
}

export function SourceTabs({
  states,
  active,
  onSelect,
}: {
  readonly states: ReadonlyArray<SourceTabState>;
  readonly active: SourceMode;
  readonly onSelect: (mode: SourceMode) => void;
}) {
  const { dict } = useLocale();

  const byMode = new Map(states.map((state) => [state.mode, state] as const));

  return (
    <div className={styles.wrap} role="tablist" aria-label={dict.home.chooseSource}>
      {SOURCE_MODES.map((mode) => {
        const state = byMode.get(mode);
        const available = state?.available ?? false;
        const isActive = mode === active;

        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={isActive}
            // The reason travels with the control, so a screen-reader user
            // learns why a tab is dimmed rather than only seeing it is.
            aria-describedby={state?.note ? `tab-note-${mode}` : undefined}
            className={[
              styles.tab,
              isActive ? styles.active : '',
              available ? '' : styles.unavailable,
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onSelect(mode)}
          >
            <span>{dict.sources[mode]}</span>

            {available && typeof state?.resultCount === 'number' ? (
              <span className={styles.count}>{state.resultCount}</span>
            ) : null}

            {!available && state?.note ? (
              <span className={styles.stateNote} id={`tab-note-${mode}`}>
                {state.note}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Builds tab state from the providers endpoint.
 *
 * `all` is available when any provider can answer; a single-source route is
 * available only when that provider can. The note explains the specific
 * blocker, taken from the capability state rather than written per tab.
 */
export function buildSourceTabStates(
  providers: ReadonlyArray<{
    readonly id: string;
    readonly capabilities: Record<string, string>;
    readonly runtimeState: string;
  }>,
  searchableProviderIds: ReadonlyArray<string>,
  dict: ReturnType<typeof useLocale>['dict'],
): ReadonlyArray<SourceTabState> {
  const states: SourceTabState[] = [
    {
      mode: 'all',
      available: searchableProviderIds.length > 0,
      note: searchableProviderIds.length > 0 ? null : dict.sources.unavailable,
    },
  ];

  for (const mode of ['temu', 'aliexpress', 'amazon'] as const) {
    const provider = providers.find((entry) => entry.id === mode);
    const available = searchableProviderIds.includes(mode);
    const searchState = provider?.capabilities.search;

    states.push({
      mode,
      available,
      note: available
        ? null
        : searchState === 'VERIFICATION_REQUIRED'
          ? dict.sources.pendingVerification
          : searchState === 'NOT_CONFIGURED'
            ? dict.sources.notConfigured
            : dict.sources.unavailable,
    });
  }

  return states;
}
