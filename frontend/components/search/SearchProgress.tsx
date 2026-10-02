'use client';

import type { SearchStage } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { Button } from '@/components/ui/Button';
import styles from './SearchProgress.module.css';

/**
 * Live search progress.
 *
 * Renders exactly what the stream reported: the current stage, each source's
 * state, how many results have arrived and how long it has taken. Nothing is
 * interpolated or smoothed.
 *
 * The reason that matters: when a source fails, the user sees "Amazon — did not
 * answer" within a second of it happening, instead of watching a bar sit at
 * 96% for twenty seconds and then being shown a short list with no explanation
 * (rule 47).
 */

export interface AttemptView {
  readonly providerId: string;
  readonly status: string;
  readonly resultCount: number;
  readonly durationMs: number | null;
  readonly reason: string | null;
}

export function SearchProgress({
  stage,
  attempts,
  elapsedMs,
  resultsSoFar,
  running,
  providerNames,
  onCancel,
}: {
  readonly stage: SearchStage | null;
  readonly attempts: ReadonlyArray<AttemptView>;
  readonly elapsedMs: number;
  readonly resultsSoFar: number;
  readonly running: boolean;
  readonly providerNames: Readonly<Record<string, string>>;
  readonly onCancel?: () => void;
}) {
  const { dict } = useLocale();

  const succeeded = attempts.filter(
    (attempt) => attempt.status === 'OK' || attempt.status === 'EMPTY',
  ).length;
  const partial = !running && attempts.length > 0 && succeeded < attempts.length;

  return (
    <div className={styles.panel} role="status" aria-live="polite" aria-atomic="false">
      <div className={styles.headline}>
        <span className={styles.stage}>
          {stage ? dict.search.stages[stage] : dict.search.searching}
        </span>

        {running ? (
          <span className={styles.dots} aria-hidden="true">
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
          </span>
        ) : null}

        <span className={styles.elapsed}>{formatElapsed(elapsedMs)}</span>
      </div>

      <ul className={styles.sources}>
        {attempts.map((attempt) => (
          <li
            key={attempt.providerId}
            className={`${styles.source} ${styles[statusClass(attempt.status)] ?? ''}`}
          >
            <span className={styles.marker} aria-hidden="true" />
            <span className={styles.sourceName}>
              {providerNames[attempt.providerId] ?? attempt.providerId}
            </span>
            <span className={styles.sourceStatus}>
              {dict.search.attemptStatus[
                attempt.status as keyof typeof dict.search.attemptStatus
              ] ?? attempt.status}
            </span>

            <span className={styles.sourceMeta}>
              {attempt.status === 'OK' ? <span>{attempt.resultCount}</span> : null}
              {attempt.durationMs !== null ? <span>{attempt.durationMs}ms</span> : null}
            </span>
          </li>
        ))}
      </ul>

      <p className={`${styles.summary} ${partial ? styles.partial : ''}`}>
        {attempts.length > 0
          ? dict.search.sourcesAvailable(succeeded, attempts.length)
          : dict.search.searching}
        {resultsSoFar > 0 ? ` · ${dict.search.resultCount(resultsSoFar)}` : ''}
      </p>

      {running && onCancel ? (
        <div className={styles.cancelRow}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {dict.search.cancel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function statusClass(status: string): keyof typeof styles {
  switch (status) {
    case 'RUNNING':
      return 'running' as keyof typeof styles;
    case 'OK':
      return 'ok' as keyof typeof styles;
    case 'EMPTY':
      return 'empty' as keyof typeof styles;
    case 'FAILED':
      return 'failed' as keyof typeof styles;
    case 'SKIPPED':
      return 'skipped' as keyof typeof styles;
    default:
      return 'source' as keyof typeof styles;
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
