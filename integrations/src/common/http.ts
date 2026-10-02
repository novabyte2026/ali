import type { AdapterFailure } from './adapter.js';

/**
 * HTTP client for provider calls.
 *
 * Responsibilities kept here rather than in each adapter: timeouts,
 * cancellation, bounded retries with jitter, response size limits and turning
 * transport problems into our error codes. Adapters stay focused on the
 * protocol shape of their own API.
 *
 * Note on retries: only idempotent reads are retried, and only on transport
 * errors or 5xx/429. A 4xx is never retried — it means our request was wrong,
 * and hammering a marketplace with a bad request is how an integration gets
 * throttled or suspended.
 */

export interface HttpRequestOptions {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly maxAttempts?: number;
  /** Guards against a provider streaming an unexpectedly huge response. */
  readonly maxResponseBytes?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly durationMs: number;
  readonly attempts: number;
}

export class HttpError extends Error {
  constructor(
    readonly failure: AdapterFailure,
    readonly status: number | null,
    readonly durationMs: number,
    readonly attempts: number,
  ) {
    super(failure.internalNote);
    this.name = 'HttpError';
  }
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const maxAttempts = options.maxAttempts ?? 3;
  const startedAt = Date.now();
  let lastError: HttpError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal.aborted) {
      throw new HttpError(
        {
          code: 'ERROR_SOURCE_UNAVAILABLE',
          retryable: false,
          internalNote: 'Request cancelled by caller',
        },
        null,
        Date.now() - startedAt,
        attempt,
      );
    }

    const attemptStartedAt = Date.now();
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs);
    // Either the caller cancelling or our timeout ends the attempt.
    const composite = AbortSignal.any([options.signal, timeoutController.signal]);

    try {
      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers as Record<string, string> | undefined,
        body: options.body,
        signal: composite,
        redirect: 'follow',
      });

      const body = await readBounded(
        response,
        options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      );
      const durationMs = Date.now() - attemptStartedAt;

      if (response.status === 429 || response.status >= 500) {
        lastError = new HttpError(
          {
            code: response.status === 429 ? 'ERROR_PROVIDER_RATE_LIMIT' : 'ERROR_SOURCE_UNAVAILABLE',
            retryable: true,
            internalNote: `HTTP ${response.status}: ${truncate(body, 300)}`,
            httpStatus: response.status,
          },
          response.status,
          durationMs,
          attempt,
        );
        if (attempt < maxAttempts) {
          await sleep(backoffDelayMs(attempt, response.headers.get('retry-after')), composite);
          continue;
        }
        throw lastError;
      }

      if (response.status === 401 || response.status === 403) {
        throw new HttpError(
          {
            code: 'ERROR_PROVIDER_AUTH_REJECTED',
            retryable: false,
            internalNote: `HTTP ${response.status}: ${truncate(body, 300)}`,
            httpStatus: response.status,
          },
          response.status,
          durationMs,
          attempt,
        );
      }

      if (response.status >= 400) {
        throw new HttpError(
          {
            code: 'ERROR_PROVIDER_RESPONSE_INVALID',
            retryable: false,
            internalNote: `HTTP ${response.status}: ${truncate(body, 300)}`,
            httpStatus: response.status,
          },
          response.status,
          durationMs,
          attempt,
        );
      }

      return {
        status: response.status,
        headers: headersToObject(response.headers),
        body,
        durationMs: Date.now() - startedAt,
        attempts: attempt,
      };
    } catch (error) {
      clearTimeout(timer);

      if (error instanceof HttpError) throw error;

      // Distinguish our own timeout from the caller cancelling the search.
      const callerCancelled = options.signal.aborted;
      const isAbort = error instanceof Error && error.name === 'AbortError';

      lastError = new HttpError(
        {
          code: isAbort && !callerCancelled ? 'ERROR_SOURCE_TIMEOUT' : 'ERROR_SOURCE_UNAVAILABLE',
          retryable: !callerCancelled,
          internalNote:
            isAbort && !callerCancelled
              ? `Timed out after ${options.timeoutMs}ms`
              : error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error),
        },
        null,
        Date.now() - attemptStartedAt,
        attempt,
      );

      if (callerCancelled || attempt >= maxAttempts) throw lastError;
      await sleep(backoffDelayMs(attempt, null), options.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ??
    new HttpError(
      { code: 'ERROR_SOURCE_UNAVAILABLE', retryable: true, internalNote: 'No attempt completed' },
      null,
      Date.now() - startedAt,
      maxAttempts,
    )
  );
}

/**
 * Reads a response body but stops at a byte ceiling. Prevents a misbehaving or
 * compromised endpoint from exhausting memory.
 */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number.parseInt(declared, 10) > maxBytes) {
    throw new HttpError(
      {
        code: 'ERROR_PROVIDER_RESPONSE_INVALID',
        retryable: false,
        internalNote: `Response declared ${declared} bytes, limit ${maxBytes}`,
      },
      response.status,
      0,
      1,
    );
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(
        {
          code: 'ERROR_PROVIDER_RESPONSE_INVALID',
          retryable: false,
          internalNote: `Response exceeded ${maxBytes} bytes`,
        },
        response.status,
        0,
        1,
      );
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Exponential backoff with full jitter, honouring Retry-After when sent. */
function backoffDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  }
  const base = Math.min(2 ** (attempt - 1) * 250, 4000);
  return Math.floor(Math.random() * base) + 100;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    // Never surface credentials or set-cookie from a provider response.
    if (key.toLowerCase() === 'set-cookie' || key.toLowerCase() === 'authorization') return;
    out[key.toLowerCase()] = value;
  });
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Parses JSON, turning a malformed body into our own error code. */
export function parseJson<T>(body: string, context: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new HttpError(
      {
        code: 'ERROR_PROVIDER_RESPONSE_INVALID',
        retryable: false,
        internalNote: `${context}: body was not JSON (${truncate(body, 200)})`,
      },
      null,
      0,
      1,
    );
  }
}
