'use client';

import { useLocale } from '@/components/LocaleProvider';
import { Button } from '@/components/ui/Button';
import styles from './EmptyState.module.css';

/**
 * Empty and error states.
 *
 * Neither is allowed to be a dead end (rules 78, 79, 174). An empty result set
 * comes with the specific reasons it might be empty and an action for each —
 * derived from the filters actually in force, not a generic "try another
 * search". An error comes with a retry and never with a stack trace, a JSON
 * body or the words "internal server error".
 */

export interface Suggestion {
  readonly key: string;
  readonly value?: string;
}

export function EmptyResults({
  suggestions,
  onSuggestion,
  onSearchAll,
}: {
  readonly suggestions: ReadonlyArray<Suggestion>;
  readonly onSuggestion: (suggestion: Suggestion) => void;
  readonly onSearchAll?: () => void;
}) {
  const { dict } = useLocale();

  return (
    <div className={styles.wrap}>
      <h2 className={styles.heading}>{dict.empty.noResults}</h2>

      {suggestions.length > 0 ? (
        <>
          <p className={styles.hint}>{dict.empty.noResultsHint}</p>
          <ul className={styles.suggestions}>
            {suggestions.map((suggestion) => (
              <li key={`${suggestion.key}-${suggestion.value ?? ''}`}>
                <button
                  type="button"
                  className={styles.suggestion}
                  onClick={() =>
                    suggestion.key === 'suggestion.searchAllSources' && onSearchAll
                      ? onSearchAll()
                      : onSuggestion(suggestion)
                  }
                >
                  {suggestionText(suggestion, dict)}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function ErrorState({
  messageKey,
  requestId,
  onRetry,
}: {
  readonly messageKey: string;
  readonly requestId?: string;
  readonly onRetry?: () => void;
}) {
  const { dict } = useLocale();

  const code = messageKey.replace(/^errors\./, '') as keyof typeof dict.errors;
  const message = dict.errors[code];

  return (
    <div className={styles.wrap} role="alert">
      <h2 className={styles.heading}>{dict.errors.heading}</h2>
      <p className={styles.hint}>
        {typeof message === 'string' ? message : dict.errors.ERROR_INTERNAL}
      </p>

      <div className={styles.actions}>
        {onRetry ? (
          <Button variant="primary" size="sm" onClick={onRetry}>
            {dict.errors.retry}
          </Button>
        ) : null}
        <Button as="link" href="/" variant="ghost" size="sm">
          {dict.errors.backHome}
        </Button>
      </div>

      {/* The request id is the one piece of internal detail worth showing: it
       * is what lets support find the exact request without the user having to
       * describe what happened. */}
      {requestId ? <p className={styles.requestId}>{requestId}</p> : null}
    </div>
  );
}

/** A generic empty panel for account lists. */
export function EmptyPanel({ message }: { readonly message: string }) {
  return (
    <div className={styles.panel}>
      <p className={styles.panelText}>{message}</p>
    </div>
  );
}

function suggestionText(
  suggestion: Suggestion,
  dict: ReturnType<typeof useLocale>['dict'],
): string {
  const leaf = suggestion.key.replace(/^suggestion\./, '') as keyof typeof dict.empty.suggestion;
  const entry = dict.empty.suggestion[leaf];

  if (typeof entry === 'function') {
    // Numeric suggestions (a raised budget, a count of failed sources) carry
    // their value in the key payload.
    const numeric = Number.parseFloat(suggestion.value ?? '');
    return Number.isFinite(numeric) && leaf !== 'raiseBudget'
      ? (entry as (n: number) => string)(numeric)
      : (entry as (v: string) => string)(suggestion.value ?? '');
  }

  return typeof entry === 'string' ? entry : suggestion.key;
}
