'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { QueryIntent } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { Button } from '@/components/ui/Button';
import { CloseIcon, SearchIcon } from '@/components/ui/Icon';
import styles from './SearchBox.module.css';

/**
 * Search field.
 *
 * Two behaviours worth noting.
 *
 * Submit is not debounced. A user who presses Enter has finished typing, and
 * making them wait 300ms for a timer is the kind of latency that is entirely
 * self-inflicted. The debounce lives on the parse preview instead, which is
 * the only thing that fires while typing.
 *
 * The "what we understood" row below the field is the honesty counterweight to
 * parsing free text. When the parser reads "up to 120" as a budget ceiling, it
 * says so and offers to remove it — so a constraint the user did not intend is
 * visible and reversible rather than silently narrowing their results.
 */

export function SearchBox({
  initialQuery = '',
  variant = 'default',
  intent,
  autoFocus = false,
  onSubmit,
  onRemoveConstraint,
}: {
  readonly initialQuery?: string;
  readonly variant?: 'default' | 'hero' | 'compact';
  readonly intent?: QueryIntent | null;
  readonly autoFocus?: boolean;
  readonly onSubmit: (query: string) => void;
  readonly onRemoveConstraint?: (recognizedText: string) => void;
}) {
  const { dict } = useLocale();
  const [value, setValue] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keep in sync when the URL changes beneath us (back button, a tab switch
  // that carries the query across).
  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      inputRef.current?.focus();
      return;
    }
    onSubmit(trimmed);
    // Blur on mobile so the keyboard gets out of the way of the results.
    if (window.matchMedia('(max-width: 640px)').matches) inputRef.current?.blur();
  };

  const recognized = intent?.recognized ?? [];

  return (
    <div>
      <form
        className={[styles.form, variant === 'hero' ? styles.hero : '', variant === 'compact' ? styles.compact : '']
          .filter(Boolean)
          .join(' ')}
        onSubmit={handleSubmit}
        role="search"
      >
        <div className={styles.field}>
          <SearchIcon className={styles.icon} size={variant === 'hero' ? 22 : 18} />

          <input
            ref={inputRef}
            className={styles.input}
            type="search"
            name="q"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={dict.home.searchPlaceholder}
            aria-label={dict.nav.search}
            autoComplete="off"
            // Off: product searches are not prose, and a capitalized first
            // letter on a phone changes "iphone" into "Iphone".
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            maxLength={300}
          />

          <div className={styles.actions}>
            {value.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={dict.common.close}
                onClick={() => {
                  setValue('');
                  inputRef.current?.focus();
                }}
              >
                <CloseIcon />
              </Button>
            ) : null}

            <Button type="submit" variant="primary" size={variant === 'hero' ? 'md' : 'sm'}>
              {dict.home.searchButton}
            </Button>
          </div>
        </div>
      </form>

      {recognized.length > 0 ? (
        <div className={styles.understood}>
          <span className={styles.understoodLabel}>{dict.search.understood}</span>
          {recognized.map((constraint) => (
            <span key={`${constraint.kind}-${constraint.text}`} className={styles.chip}>
              {constraint.valueLabel}
              {onRemoveConstraint ? (
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`${dict.search.removeConstraint}: ${constraint.valueLabel}`}
                  onClick={() => onRemoveConstraint(constraint.text)}
                >
                  <CloseIcon />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
