/**
 * Rate limiting and circuit breaking, per provider.
 *
 * These exist for two reasons that pull in the same direction. A marketplace
 * quota is a contractual limit — Amazon's PA-API in particular starts at about
 * one request per second and is reduced if you exceed it — so staying under it
 * protects the integration. And when a source is failing, continuing to call
 * it makes every search slower for everyone, so the breaker turns a 30-second
 * timeout into an immediate "this source is unavailable".
 *
 * One source going down must never take the product down (rule 76).
 */

export interface TokenBucketOptions {
  readonly requestsPerSecond: number;
  readonly burst: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(private readonly options: TokenBucketOptions) {
    this.tokens = options.burst;
    this.lastRefillAt = Date.now();
  }

  /** Milliseconds a caller must wait, or 0 when a token is available now. */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillAt) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(
      this.options.burst,
      this.tokens + elapsedSeconds * this.options.requestsPerSecond,
    );
    this.lastRefillAt = now;
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  delayUntilAvailableMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil((deficit / this.options.requestsPerSecond) * 1000);
  }

  /**
   * Waits for a token, up to `maxWaitMs`. Returns false when the wait would
   * exceed the budget, so a search gives up on a throttled provider rather
   * than making the whole page slow.
   */
  async acquire(maxWaitMs: number, signal: AbortSignal): Promise<boolean> {
    const delay = this.delayUntilAvailableMs();
    if (delay === 0) return this.tryConsume();
    if (delay > maxWaitMs) return false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      function onAbort(): void {
        clearTimeout(timer);
        reject(new Error('cancelled'));
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });

    return this.tryConsume();
  }

  get currentlyThrottled(): boolean {
    this.refill();
    return this.tokens < 1;
  }
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. */
  readonly failureThreshold: number;
  /** How long to stay open before allowing one probe. */
  readonly openMs: number;
  /** Consecutive successes in HALF_OPEN before closing. */
  readonly successThreshold: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;

  constructor(private readonly options: CircuitBreakerOptions) {}

  /** Whether a call may proceed. Transitions OPEN -> HALF_OPEN on timeout. */
  allowRequest(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.options.openMs) {
        this.state = 'HALF_OPEN';
        this.consecutiveSuccesses = 0;
        return true;
      }
      return false;
    }
    // HALF_OPEN: let probes through; a failure re-opens immediately.
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.options.successThreshold) {
        this.state = 'CLOSED';
        this.consecutiveSuccesses = 0;
      }
    }
  }

  /**
   * Only transport-level failures count toward opening. A provider correctly
   * answering "no results" or rejecting a malformed request is not a sign the
   * source is down, and treating it as one would disable a working integration.
   */
  recordFailure(): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures += 1;
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }

  get currentState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.options.openMs) {
      return 'HALF_OPEN';
    }
    return this.state;
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }
}

/** Per-provider resilience state, held for the process lifetime. */
export class ProviderResilience {
  readonly bucket: TokenBucket;
  readonly breaker: CircuitBreaker;

  constructor(
    readonly providerId: string,
    rateLimit: TokenBucketOptions,
    breaker: CircuitBreakerOptions = { failureThreshold: 5, openMs: 30_000, successThreshold: 2 },
  ) {
    this.bucket = new TokenBucket(rateLimit);
    this.breaker = new CircuitBreaker(breaker);
  }
}

const REGISTRY = new Map<string, ProviderResilience>();

export function resilienceFor(
  providerId: string,
  rateLimit: TokenBucketOptions,
): ProviderResilience {
  const existing = REGISTRY.get(providerId);
  if (existing) return existing;
  const created = new ProviderResilience(providerId, rateLimit);
  REGISTRY.set(providerId, created);
  return created;
}

/** Test seam: clears process-wide resilience state between cases. */
export function resetResilience(): void {
  REGISTRY.clear();
}
