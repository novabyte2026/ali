import { Redis } from 'ioredis';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';

/**
 * Cache abstraction.
 *
 * Two drivers. The in-memory one is correct for a single process and is what
 * development uses; it is refused at boot in production because two backend
 * instances with separate caches produce inconsistent prices between requests,
 * which in a comparison product means two users see different answers.
 *
 * The important rule this layer enforces: a TTL of zero means do not cache.
 * Provider policies that forbid retention resolve to zero, and `set` then
 * becomes a no-op rather than caching with a short TTL — a policy that says
 * "request-scoped only" means exactly that.
 *
 * Cache failures never fail a request. If Redis is unreachable the product
 * gets slower, not broken.
 */

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes every key under a prefix. Used after an operator policy change. */
  deletePrefix(prefix: string): Promise<number>;
  stats(): CacheStats;
  close(): Promise<void>;
}

export interface CacheStats {
  readonly driver: 'memory' | 'redis';
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
  readonly skippedByPolicy: number;
  readonly errors: number;
  readonly hitRate: number | null;
  readonly entries: number | null;
}

export function createCache(config: AppConfig, log: Logger): Cache {
  return config.cache.driver === 'redis'
    ? createRedisCache(config, log)
    : createMemoryCache(log);
}

// --- Memory ---------------------------------------------------------------

export function createMemoryCache(log: Logger, maxEntries = 5000): Cache {
  interface Entry {
    readonly value: unknown;
    readonly expiresAt: number;
  }

  const store = new Map<string, Entry>();
  let hits = 0;
  let misses = 0;
  let writes = 0;
  let skippedByPolicy = 0;

  function evictIfNeeded(): void {
    if (store.size <= maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) store.delete(key);
    }
    // Map preserves insertion order, so the oldest keys come first.
    while (store.size > maxEntries) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry) {
        misses += 1;
        return null;
      }
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        misses += 1;
        return null;
      }
      hits += 1;
      return entry.value as T;
    },

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      if (ttlSeconds <= 0) {
        skippedByPolicy += 1;
        return;
      }
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      writes += 1;
      evictIfNeeded();
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    async deletePrefix(prefix: string): Promise<number> {
      let removed = 0;
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    stats(): CacheStats {
      const total = hits + misses;
      return {
        driver: 'memory',
        hits,
        misses,
        writes,
        skippedByPolicy,
        errors: 0,
        hitRate: total === 0 ? null : hits / total,
        entries: store.size,
      };
    },

    async close(): Promise<void> {
      store.clear();
      log.debug('Memory cache cleared');
    },
  };
}

// --- Redis ----------------------------------------------------------------

function createRedisCache(config: AppConfig, log: Logger): Cache {
  const client = new Redis(config.cache.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    // A cache read must never outlive the request that needs it.
    commandTimeout: 500,
    retryStrategy: (times) => Math.min(times * 200, 3000),
  });

  let hits = 0;
  let misses = 0;
  let writes = 0;
  let skippedByPolicy = 0;
  let errors = 0;

  client.on('error', (error: Error) => {
    errors += 1;
    // Logged at warn, not error: a cache outage degrades latency, and paging
    // on it would train people to ignore the alert.
    log.warn('Redis cache error', { error });
  });

  const prefix = 'shelf:';

  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const raw = await client.get(prefix + key);
        if (raw === null) {
          misses += 1;
          return null;
        }
        hits += 1;
        return JSON.parse(raw) as T;
      } catch (error) {
        errors += 1;
        log.warn('Cache read failed, treating as miss', { error });
        return null;
      }
    },

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
      if (ttlSeconds <= 0) {
        skippedByPolicy += 1;
        return;
      }
      try {
        await client.set(prefix + key, JSON.stringify(value), 'EX', Math.floor(ttlSeconds));
        writes += 1;
      } catch (error) {
        errors += 1;
        log.warn('Cache write failed', { error });
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await client.del(prefix + key);
      } catch (error) {
        errors += 1;
        log.warn('Cache delete failed', { error });
      }
    },

    /** Uses SCAN rather than KEYS, which would block the Redis event loop. */
    async deletePrefix(keyPrefix: string): Promise<number> {
      let removed = 0;
      try {
        let cursor = '0';
        do {
          const [next, keys] = await client.scan(
            cursor,
            'MATCH',
            `${prefix}${keyPrefix}*`,
            'COUNT',
            200,
          );
          cursor = next;
          if (keys.length > 0) {
            removed += await client.del(...keys);
          }
        } while (cursor !== '0');
      } catch (error) {
        errors += 1;
        log.warn('Cache prefix delete failed', { error });
      }
      return removed;
    },

    stats(): CacheStats {
      const total = hits + misses;
      return {
        driver: 'redis',
        hits,
        misses,
        writes,
        skippedByPolicy,
        errors,
        hitRate: total === 0 ? null : hits / total,
        entries: null,
      };
    },

    async close(): Promise<void> {
      await client.quit().catch(() => client.disconnect());
    },
  };
}
