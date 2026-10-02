'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  SearchResultItem,
  SearchStage,
  SearchStreamEvent,
  SearchSummary,
} from '@shelf/shared';
import { ApiError, type SearchParams, streamSearch } from './api';

/**
 * Client hooks.
 *
 * Three of these implement the motion and streaming behaviour the brief asks
 * for; all three are built so that nothing animates or spins unless real work
 * is happening behind it.
 */

/**
 * Reveals an element when it enters the viewport.
 *
 * Uses IntersectionObserver and unobserves after the first reveal, so
 * scrolling back up does not replay the animation (rule 52) and a long results
 * page is not holding an observer per card forever.
 *
 * Honours reduced motion by marking visible immediately — the alternative,
 * leaving elements at opacity 0 when the transition is disabled, is the bug
 * that makes reduced-motion pages render blank.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(options: {
  readonly rootMargin?: string;
  readonly disabled?: boolean;
} = {}) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (options.disabled || prefersReduced || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    // Anything already at or above the fold is shown immediately rather than
    // waiting for an intersection callback. Without this, content that is
    // on-screen at mount can sit at opacity 0 until the first scroll — and on
    // a short page, or in a screenshot, it never appears at all.
    const rect = element.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setVisible(true);
          observer.unobserve(entry.target);
        }
      },
      // A negative bottom margin means the reveal fires slightly before the
      // element is fully in view, so it has finished by the time it is read.
      { rootMargin: options.rootMargin ?? '0px 0px -8% 0px', threshold: 0.05 },
    );

    observer.observe(element);

    // Backstop. If no intersection ever fires — an observer that never
    // dispatches, a container that scrolls in a way we did not anticipate —
    // the content becomes visible anyway. Hidden content is a worse failure
    // than an un-animated reveal.
    const backstop = setTimeout(() => {
      setVisible(true);
      observer.disconnect();
    }, 2000);

    return () => {
      clearTimeout(backstop);
      observer.disconnect();
    };
  }, [options.disabled, options.rootMargin]);

  return { ref, visible } as const;
}

/**
 * Scroll progress, 0..1.
 *
 * Driven by requestAnimationFrame off a passive scroll listener rather than
 * writing to state on every scroll event, which would re-render the tree
 * dozens of times a second on a long results page.
 */
export function useScrollProgress(): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;

    const update = (): void => {
      frame = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable <= 0 ? 0 : Math.min(1, Math.max(0, window.scrollY / scrollable)));
    };

    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return progress;
}

export interface SearchStreamState {
  readonly items: ReadonlyArray<SearchResultItem>;
  readonly summary: SearchSummary | null;
  readonly stage: SearchStage | null;
  readonly attempts: ReadonlyArray<{
    readonly providerId: string;
    readonly status: string;
    readonly resultCount: number;
    readonly durationMs: number | null;
    readonly reason: string | null;
  }>;
  readonly elapsedMs: number;
  readonly running: boolean;
  readonly error: ApiError | null;
  readonly resultsSoFar: number;
}

const IDLE: SearchStreamState = {
  items: [],
  summary: null,
  stage: null,
  attempts: [],
  elapsedMs: 0,
  running: false,
  error: null,
  resultsSoFar: 0,
};

/**
 * Runs a streaming search.
 *
 * The state it exposes is exactly what the server reported — stage, per-source
 * status, elapsed time. Nothing is interpolated and no progress is invented,
 * which is why the progress panel can render it verbatim (rule 47).
 *
 * Starting a new search aborts the previous one. That cancels the in-flight
 * provider calls server-side rather than leaving them to finish against a
 * quota nobody will read the results of (rule 57).
 */
export function useSearchStream() {
  const [state, setState] = useState<SearchStreamState>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((current) => ({ ...current, running: false }));
  }, []);

  const run = useCallback(async (params: SearchParams) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState({ ...IDLE, running: true });

    try {
      await streamSearch(params, {
        signal: controller.signal,
        onEvent: (event) => {
          if (controller.signal.aborted) return;

          setState((current) => {
            switch (event.type) {
              case 'progress':
                return {
                  ...current,
                  stage: event.stage,
                  attempts: event.attempts.map((attempt) => ({ ...attempt })),
                  elapsedMs: event.elapsedMs,
                  resultsSoFar: event.resultsSoFar,
                };

              case 'results':
                return {
                  ...current,
                  // `replacesPrevious` lets the server send a final ranked set
                  // after incremental batches, so the list is not appended to
                  // twice.
                  items: event.replacesPrevious ? [...event.items] : [...current.items, ...event.items],
                };

              case 'done':
                return {
                  ...current,
                  summary: event.summary,
                  attempts: event.summary.attempts.map((attempt) => ({ ...attempt })),
                  elapsedMs: event.summary.elapsedMs,
                  stage: 'DONE',
                  running: false,
                };

              case 'error':
                return {
                  ...current,
                  running: false,
                  error: new ApiError(event.code, 0, null, event.requestId, false),
                };
            }
          });
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        running: false,
        error: error instanceof ApiError ? error : new ApiError('ERROR_INTERNAL', 0, null, '-', true),
      }));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setState((current) => (current.running ? { ...current, running: false } : current));
    }
  }, []);

  // Abort on unmount so navigating away stops the provider calls.
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { ...state, run, cancel } as const;
}

/**
 * Debounces a value.
 *
 * Used for the search field so we are not issuing a request per keystroke
 * (rule 56) — but the submit path is deliberately not debounced, because a
 * user who presses Enter has finished typing and should not wait.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Copies text and reports success for a moment.
 *
 * Uses the async clipboard API with a `document.execCommand` fallback, because
 * the modern API is unavailable on a non-secure origin and copying a coupon
 * code is the one interaction where silently doing nothing is worst.
 */
export function useCopy(resetAfterMs = 2000) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (text: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const field = document.createElement('textarea');
          field.value = text;
          field.setAttribute('readonly', '');
          field.style.position = 'fixed';
          field.style.opacity = '0';
          document.body.appendChild(field);
          field.select();
          document.execCommand('copy');
          document.body.removeChild(field);
        }
        setCopied(true);
        return true;
      } catch {
        setCopied(false);
        return false;
      }
    },
    [],
  );

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), resetAfterMs);
    return () => clearTimeout(timer);
  }, [copied, resetAfterMs]);

  return { copied, copy } as const;
}

/** Reads a media query reactively. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/**
 * Stable per-render identity for a list of result items, used as React keys.
 *
 * Group ids are stable across renders for the same product, so keys do not
 * change when a filter re-orders the list — which is what lets the card
 * reorder transition work instead of remounting everything.
 */
export function useItemKeys(items: ReadonlyArray<SearchResultItem>): ReadonlyArray<string> {
  return useMemo(() => items.map((item) => item.group.groupId), [items]);
}
