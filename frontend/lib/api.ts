import type {
  PublicErrorBody,
  SearchResponse,
  SearchStreamEvent,
} from '@shelf/shared';

/**
 * API client.
 *
 * Deliberately thin: one `request` function, typed responses, and an error
 * class that carries the backend's code so a component can decide what to do
 * rather than parsing a message. The backend never sends prose, so there is no
 * message to parse — the code maps to copy in the dictionary.
 *
 * `credentials: 'include'` is required for the session cookie, which is
 * httpOnly and therefore invisible to this code. That is intentional: the
 * frontend never handles a token.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: Record<string, unknown> | null,
    readonly requestId: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'ApiError';
  }

  /** Translation key for user-facing copy. */
  get messageKey(): string {
    return `errors.${this.code}`;
  }
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly query?: Record<string, string | number | boolean | undefined | null>;
  /** Next.js fetch cache hint for server components. */
  readonly revalidate?: number | false;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const init: RequestInit & { next?: { revalidate: number | false } } = {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  if (options.revalidate !== undefined) {
    init.next = { revalidate: options.revalidate };
  } else {
    // Search and product data is time-sensitive and carries its own observed
    // time; caching it in the fetch layer would undermine the freshness note.
    init.cache = 'no-store';
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // A network failure is not the backend's error taxonomy, so it is mapped
    // into it here rather than surfacing a browser message.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('ERROR_DEPENDENCY_UNAVAILABLE', 0, null, 'network', true);
  }

  if (!response.ok) {
    const requestId = response.headers.get('x-request-id') ?? 'unknown';
    let body: PublicErrorBody | null = null;
    try {
      body = (await response.json()) as PublicErrorBody;
    } catch {
      body = null;
    }
    throw new ApiError(
      body?.error.code ?? 'ERROR_INTERNAL',
      response.status,
      (body?.error.details as Record<string, unknown> | null) ?? null,
      body?.error.requestId ?? requestId,
      body?.error.retryable ?? false,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- Typed endpoints ------------------------------------------------------

export interface ProvidersResponse {
  readonly providers: ReadonlyArray<{
    readonly id: string;
    readonly branding: {
      readonly displayName: string;
      readonly logoPermitted: boolean;
      readonly logoAssetPath: string | null;
      readonly attributionNotice: string | null;
    };
    readonly countries: ReadonlyArray<string>;
    readonly defaultCountry: string;
    readonly currencies: ReadonlyArray<string>;
    readonly capabilities: Record<string, string>;
    readonly runtimeState: string;
    readonly policyVersion: string;
    readonly servingDemoFixtures: boolean;
  }>;
  readonly searchableProviderIds: ReadonlyArray<string>;
  readonly anyDemoFixtures: boolean;
}

export function fetchProviders(signal?: AbortSignal): Promise<ProvidersResponse> {
  return apiRequest<ProvidersResponse>('/api/v1/providers', {
    ...(signal ? { signal } : {}),
    // Provider capabilities change on an operator action, not per request.
    revalidate: 30,
  });
}

export interface SearchParams {
  readonly q: string;
  readonly source?: string;
  readonly country?: string;
  readonly currency?: string;
  readonly locale?: string;
  readonly sort?: string;
  readonly page?: number;
  readonly priceMin?: string;
  readonly priceMax?: string;
  readonly minRating?: string;
  readonly freeShipping?: boolean;
  readonly withCoupon?: boolean;
  readonly exactMatch?: boolean;
  readonly allowAboveBudget?: boolean;
  readonly brands?: string;
}

export function fetchSearch(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  return apiRequest<SearchResponse>('/api/v1/search', {
    query: params as unknown as Record<string, string>,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Streams a search over server-sent events.
 *
 * Implemented with fetch and a reader rather than `EventSource`, because
 * EventSource cannot send credentials cross-origin and cannot be aborted
 * cleanly — and aborting matters here: a user who retypes should cancel the
 * previous search rather than leave it running against provider quota.
 */
export async function streamSearch(
  params: SearchParams,
  handlers: {
    readonly onEvent: (event: SearchStreamEvent) => void;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const url = new URL(`${API_BASE}/api/v1/search/stream`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    credentials: 'include',
    headers: { accept: 'text/event-stream' },
    signal: handlers.signal,
    cache: 'no-store',
  });

  if (!response.ok || !response.body) {
    const requestId = response.headers.get('x-request-id') ?? 'unknown';
    let code = 'ERROR_INTERNAL';
    try {
      const body = (await response.json()) as PublicErrorBody;
      code = body.error.code;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(code, response.status, null, requestId, false);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. A partial frame stays in the
    // buffer until the rest arrives.
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue; // Skip `: keepalive` comments.
        try {
          handlers.onEvent(JSON.parse(line.slice(6)) as SearchStreamEvent);
        } catch {
          // A malformed frame is dropped rather than ending the stream; the
          // next frame is probably fine.
        }
      }
    }
  }
}

export function fetchParsedQuery(
  q: string,
  signal?: AbortSignal,
): Promise<{ readonly intent: SearchResponse['summary']['intent'] }> {
  return apiRequest('/api/v1/search/parse', { query: { q }, ...(signal ? { signal } : {}) });
}

export interface SearchExample {
  readonly text: string;
  readonly query: string;
}

export function fetchSearchExamples(
  locale: string,
): Promise<{ readonly examples: ReadonlyArray<SearchExample> }> {
  return apiRequest('/api/v1/search/examples', { query: { locale }, revalidate: 3600 });
}

export function fetchProduct(
  providerId: string,
  providerProductId: string,
  params: { country?: string; currency?: string; locale?: string } = {},
): Promise<unknown> {
  return apiRequest(
    `/api/v1/products/${encodeURIComponent(providerId)}/${encodeURIComponent(providerProductId)}`,
    { query: params as Record<string, string> },
  );
}

export function fetchComparison(
  providerId: string,
  providerProductId: string,
  params: { country?: string; currency?: string; locale?: string } = {},
): Promise<unknown> {
  return apiRequest(
    `/api/v1/products/${encodeURIComponent(providerId)}/${encodeURIComponent(providerProductId)}/comparison`,
    { query: params as Record<string, string> },
  );
}

export interface AffiliateLinkResponse {
  readonly link: {
    readonly providerId: string;
    readonly destinationUrl: string;
    readonly affiliateUrl: string;
    readonly destinationHost: string;
    readonly status: string;
    readonly placement: string;
    readonly disclosureRequired: boolean;
    readonly disclosureKey: string | null;
    readonly disclosureText: string | null;
  };
  readonly tracked: boolean;
}

/**
 * Records the click and returns where to navigate.
 *
 * Called on activation rather than on render, so a page of twenty results does
 * not generate twenty link records. The destination host is returned so the UI
 * can show the user where they are going before they leave.
 */
export function recordAffiliateClick(body: {
  readonly providerId: string;
  readonly providerProductId: string;
  readonly destinationUrl: string;
  readonly productGroupId?: string;
  readonly placement: string;
  readonly locale?: string;
  readonly country?: string;
}): Promise<{
  readonly clickId: string;
  readonly navigateTo: string;
  readonly destinationHost: string;
  readonly tracked: boolean;
}> {
  return apiRequest('/api/v1/affiliate/click', { method: 'POST', body });
}

export interface AuthState {
  readonly authenticated: boolean;
  readonly role: string;
  readonly permissions: ReadonlyArray<string>;
  readonly signInAvailable: boolean;
  readonly profile?: {
    readonly userId: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly avatarUrl: string | null;
    readonly role: string;
    readonly preferences: {
      readonly locale: 'he' | 'en';
      readonly countryCode: string;
      readonly currency: string;
      readonly defaultSourceMode: string;
      readonly defaultSort: string;
      readonly reducedMotion: boolean;
    };
    readonly privacy: Record<string, boolean>;
    readonly notifications: Record<string, boolean | string>;
  };
}

export function fetchAuthState(signal?: AbortSignal): Promise<AuthState> {
  return apiRequest<AuthState>('/api/v1/auth/me', { ...(signal ? { signal } : {}) });
}

export function startGoogleSignIn(redirect?: string): Promise<{ readonly authorizationUrl: string }> {
  return apiRequest('/api/v1/auth/google/start', {
    query: redirect ? { redirect } : {},
  });
}

export function signOut(): Promise<{ readonly signedOut: boolean }> {
  return apiRequest('/api/v1/auth/signout', { method: 'POST' });
}

/**
 * Posts analytics events.
 *
 * Fire-and-forget by design: a failed analytics post must never surface to the
 * user or block an interaction, so the promise rejection is swallowed.
 */
export function sendAnalytics(
  events: ReadonlyArray<{
    readonly type: string;
    readonly providerId?: string;
    readonly properties?: Record<string, string | number | boolean | null>;
  }>,
): void {
  if (events.length === 0) return;
  void apiRequest('/api/v1/analytics/events', { method: 'POST', body: { events } }).catch(
    () => undefined,
  );
}

export function fetchCoupons(params: {
  source?: string;
  country?: string;
}): Promise<unknown> {
  return apiRequest('/api/v1/coupons', { query: params as Record<string, string> });
}

export function fetchDeals(params: { source?: string; country?: string }): Promise<unknown> {
  return apiRequest('/api/v1/deals', { query: params as Record<string, string> });
}

export function fetchTransparency(): Promise<unknown> {
  return apiRequest('/api/v1/affiliate/transparency', { revalidate: 3600 });
}

export function fetchFeatureStatus(): Promise<unknown> {
  return apiRequest('/api/v1/meta/features', { revalidate: 300 });
}

export function analyzeUrl(body: {
  readonly url: string;
  readonly country?: string;
  readonly currency?: string;
}): Promise<unknown> {
  return apiRequest('/api/v1/products/analyze-url', { method: 'POST', body });
}
