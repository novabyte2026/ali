import { AppError } from '@shelf/shared';
import type { IntegrationsConfig } from '@shelf/integrations';

/**
 * Configuration, read once at boot and validated before anything starts.
 *
 * The validation is deliberately strict about a short list of things that are
 * dangerous to get wrong in production, and the process refuses to boot rather
 * than starting in a state that would mislead users:
 *
 *   - demo fixtures enabled in production
 *   - a missing or weak session secret
 *   - insecure cookies with a https public URL
 *   - an in-memory cache or queue driver in production
 *
 * Everything else degrades: a provider with no credentials reports itself as
 * not configured, and the product works with the sources that are.
 */

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly isProduction: boolean;

  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly publicApiUrl: string;
    readonly publicWebUrl: string;
    readonly corsAllowedOrigins: ReadonlyArray<string>;
  };

  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly ssl: boolean;
  };

  readonly cache: { readonly driver: 'memory' | 'redis'; readonly redisUrl: string };
  readonly queue: { readonly driver: 'memory' | 'redis'; readonly redisUrl: string };

  readonly session: {
    readonly secret: string;
    readonly cookieName: string;
    readonly ttlHours: number;
    readonly cookieSecure: boolean;
  };

  readonly google: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly configured: boolean;
  };

  readonly adminEmails: ReadonlyArray<string>;

  readonly integrations: IntegrationsConfig;

  readonly fx: {
    readonly driver: 'static' | 'http';
    readonly httpUrl: string;
    readonly httpApiKey: string;
    readonly refreshMinutes: number;
  };

  readonly mail: {
    readonly driver: 'console' | 'smtp';
    readonly smtpUrl: string;
    readonly from: string;
  };

  readonly search: {
    /** Wall-clock budget for one provider call. */
    readonly providerTimeoutMs: number;
    /** Budget for the whole aggregated search. */
    readonly totalTimeoutMs: number;
    readonly defaultPageSize: number;
    readonly maxPageSize: number;
    /**
     * How old a cached figure may be before it is demoted to UNKNOWN at the
     * API boundary. Independent of cache TTL: the cache may still hold it, but
     * we will not present it as current.
     */
    readonly freshnessToleranceSeconds: number;
  };

  readonly rateLimits: {
    readonly searchPerMinutePerSession: number;
    readonly apiPerMinutePerSession: number;
    readonly authPerHourPerIp: number;
  };

  readonly retention: {
    readonly analyticsEventDays: number;
    readonly telemetryDays: number;
    readonly searchHistoryDays: number;
    readonly providerCallLogDays: number;
  };
}

class ConfigError extends Error {
  constructor(problems: ReadonlyArray<string>) {
    super(
      `Configuration is not valid, refusing to start:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = pickEnum(env.NODE_ENV, ['development', 'test', 'production'], 'development');
  const isProduction = nodeEnv === 'production';

  const allowDemoFixtures = asBoolean(env.ALLOW_DEMO_FIXTURES, !isProduction);

  const config: AppConfig = {
    nodeEnv,
    logLevel: pickEnum(env.LOG_LEVEL, ['debug', 'info', 'warn', 'error'], 'info'),
    isProduction,

    http: {
      host: env.BACKEND_HOST ?? '0.0.0.0',
      port: asInteger(env.BACKEND_PORT, 4000),
      publicApiUrl: trimSlash(env.PUBLIC_API_URL ?? 'http://localhost:4000'),
      publicWebUrl: trimSlash(env.PUBLIC_WEB_URL ?? 'http://localhost:3000'),
      corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000')
        .split(',')
        .map((origin) => trimSlash(origin.trim()))
        .filter(Boolean),
    },

    database: {
      url: env.DATABASE_URL ?? '',
      poolMax: asInteger(env.DATABASE_POOL_MAX, 10),
      ssl: asBoolean(env.DATABASE_SSL, false),
    },

    cache: {
      driver: pickEnum(env.CACHE_DRIVER, ['memory', 'redis'], 'memory'),
      redisUrl: env.REDIS_URL ?? '',
    },
    queue: {
      driver: pickEnum(env.QUEUE_DRIVER, ['memory', 'redis'], 'memory'),
      redisUrl: env.REDIS_URL ?? '',
    },

    session: {
      secret: env.SESSION_SECRET ?? '',
      cookieName: env.SESSION_COOKIE_NAME ?? 'shelf_session',
      ttlHours: asInteger(env.SESSION_TTL_HOURS, 720),
      cookieSecure: asBoolean(env.SESSION_COOKIE_SECURE, isProduction),
    },

    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirectUri: env.GOOGLE_REDIRECT_URI ?? '',
      configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI),
    },

    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),

    integrations: {
      amazon: {
        enabled: asBoolean(env.AMAZON_ENABLED, false),
        accessKey: env.AMAZON_ACCESS_KEY ?? '',
        secretKey: env.AMAZON_SECRET_KEY ?? '',
        partnerTag: env.AMAZON_PARTNER_TAG ?? '',
        host: env.AMAZON_HOST ?? 'webservices.amazon.com',
        region: env.AMAZON_REGION ?? 'us-east-1',
        marketplace: env.AMAZON_MARKETPLACE ?? 'www.amazon.com',
        defaultCountry: (env.AMAZON_DEFAULT_COUNTRY ?? 'US').toUpperCase(),
        rateLimitRps: asNumber(env.AMAZON_RATE_LIMIT_RPS, 1),
        rateLimitBurst: asInteger(env.AMAZON_RATE_LIMIT_BURST, 1),
      },
      aliexpress: {
        enabled: asBoolean(env.ALIEXPRESS_ENABLED, false),
        appKey: env.ALIEXPRESS_APP_KEY ?? '',
        appSecret: env.ALIEXPRESS_APP_SECRET ?? '',
        gateway: env.ALIEXPRESS_GATEWAY ?? 'https://api-sg.aliexpress.com/sync',
        trackingId: env.ALIEXPRESS_TRACKING_ID ?? '',
        defaultCountry: (env.ALIEXPRESS_DEFAULT_COUNTRY ?? 'IL').toUpperCase(),
        rateLimitRps: asNumber(env.ALIEXPRESS_RATE_LIMIT_RPS, 5),
        rateLimitBurst: asInteger(env.ALIEXPRESS_RATE_LIMIT_BURST, 10),
      },
      temu: {
        enabled: asBoolean(env.TEMU_ENABLED, false),
        apiBaseUrl: env.TEMU_API_BASE_URL ?? '',
        appKey: env.TEMU_APP_KEY ?? '',
        appSecret: env.TEMU_APP_SECRET ?? '',
        affiliateId: env.TEMU_AFFILIATE_ID ?? '',
        defaultCountry: (env.TEMU_DEFAULT_COUNTRY ?? 'IL').toUpperCase(),
        rateLimitRps: asNumber(env.TEMU_RATE_LIMIT_RPS, 2),
        rateLimitBurst: asInteger(env.TEMU_RATE_LIMIT_BURST, 4),
      },
      allowDemoFixtures,
      requestTimeoutMs: asInteger(env.PROVIDER_TIMEOUT_MS, 6000),
      rateLimitWaitMs: asInteger(env.PROVIDER_RATE_LIMIT_WAIT_MS, 1200),
    },

    fx: {
      driver: pickEnum(env.FX_DRIVER, ['static', 'http'], 'static'),
      httpUrl: env.FX_HTTP_URL ?? '',
      httpApiKey: env.FX_HTTP_API_KEY ?? '',
      refreshMinutes: asInteger(env.FX_REFRESH_MINUTES, 720),
    },

    mail: {
      driver: pickEnum(env.MAIL_DRIVER, ['console', 'smtp'], 'console'),
      smtpUrl: env.SMTP_URL ?? '',
      from: env.MAIL_FROM ?? 'Shelf <no-reply@example.com>',
    },

    search: {
      providerTimeoutMs: asInteger(env.PROVIDER_TIMEOUT_MS, 6000),
      totalTimeoutMs: asInteger(env.SEARCH_TOTAL_TIMEOUT_MS, 9000),
      defaultPageSize: asInteger(env.SEARCH_DEFAULT_PAGE_SIZE, 24),
      maxPageSize: asInteger(env.SEARCH_MAX_PAGE_SIZE, 48),
      freshnessToleranceSeconds: asInteger(env.SEARCH_FRESHNESS_TOLERANCE_SECONDS, 3600),
    },

    rateLimits: {
      searchPerMinutePerSession: asInteger(env.RATE_LIMIT_SEARCH_PER_MINUTE, 30),
      apiPerMinutePerSession: asInteger(env.RATE_LIMIT_API_PER_MINUTE, 240),
      authPerHourPerIp: asInteger(env.RATE_LIMIT_AUTH_PER_HOUR, 20),
    },

    retention: {
      analyticsEventDays: asInteger(env.RETENTION_ANALYTICS_DAYS, 90),
      telemetryDays: asInteger(env.RETENTION_TELEMETRY_DAYS, 30),
      searchHistoryDays: asInteger(env.RETENTION_SEARCH_HISTORY_DAYS, 180),
      providerCallLogDays: asInteger(env.RETENTION_PROVIDER_CALL_LOG_DAYS, 14),
    },
  };

  const problems = validate(config);
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * Boot-time refusals. Each one of these, shipped silently, would make the
 * product lie to someone or lose their session, so none of them is a warning.
 */
function validate(config: AppConfig): string[] {
  const problems: string[] = [];

  if (!config.database.url) {
    problems.push('DATABASE_URL is required.');
  }

  if (!config.session.secret) {
    problems.push('SESSION_SECRET is required. Generate one with: openssl rand -base64 48');
  } else if (config.session.secret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters.');
  }

  if (config.isProduction) {
    // Sample data presented as real offers is the single worst failure mode
    // this product has, so it is a hard boot failure rather than a warning.
    if (config.integrations.allowDemoFixtures) {
      problems.push(
        'ALLOW_DEMO_FIXTURES must be false in production. Demo fixtures are sample data and must never be served as real offers.',
      );
    }

    if (!config.session.cookieSecure) {
      problems.push('SESSION_COOKIE_SECURE must be true in production.');
    }

    if (config.cache.driver === 'memory') {
      problems.push(
        'CACHE_DRIVER=memory is single-process only. Set CACHE_DRIVER=redis in production.',
      );
    }
    if (config.queue.driver === 'memory') {
      problems.push(
        'QUEUE_DRIVER=memory loses jobs on restart. Set QUEUE_DRIVER=redis in production.',
      );
    }

    if (config.http.publicWebUrl.startsWith('http://')) {
      problems.push('PUBLIC_WEB_URL must use https in production.');
    }

    if (config.fx.driver === 'static') {
      problems.push(
        'FX_DRIVER=static ships a fixed rate table and cannot produce current conversions. Configure FX_DRIVER=http in production.',
      );
    }

    if (config.mail.driver === 'console') {
      problems.push('MAIL_DRIVER=console does not deliver mail. Configure SMTP in production.');
    }
  }

  if (config.cache.driver === 'redis' && !config.cache.redisUrl) {
    problems.push('CACHE_DRIVER=redis requires REDIS_URL.');
  }
  if (config.queue.driver === 'redis' && !config.queue.redisUrl) {
    problems.push('QUEUE_DRIVER=redis requires REDIS_URL.');
  }
  if (config.fx.driver === 'http' && !config.fx.httpUrl) {
    problems.push('FX_DRIVER=http requires FX_HTTP_URL.');
  }
  if (config.mail.driver === 'smtp' && !config.mail.smtpUrl) {
    problems.push('MAIL_DRIVER=smtp requires SMTP_URL.');
  }

  if (config.search.maxPageSize < config.search.defaultPageSize) {
    problems.push('SEARCH_MAX_PAGE_SIZE must be at least SEARCH_DEFAULT_PAGE_SIZE.');
  }

  return problems;
}

/**
 * Boot summary for the log. Lists what is configured and what is degraded,
 * without printing a single credential value.
 */
export function describeConfig(config: AppConfig): Record<string, string | number | boolean> {
  return {
    nodeEnv: config.nodeEnv,
    port: config.http.port,
    cacheDriver: config.cache.driver,
    queueDriver: config.queue.driver,
    demoFixtures: config.integrations.allowDemoFixtures,
    googleSignIn: config.google.configured,
    amazonConfigured: Boolean(
      config.integrations.amazon.enabled && config.integrations.amazon.accessKey,
    ),
    aliexpressConfigured: Boolean(
      config.integrations.aliexpress.enabled && config.integrations.aliexpress.appKey,
    ),
    temuConfigured: Boolean(
      config.integrations.temu.enabled && config.integrations.temu.apiBaseUrl,
    ),
    fxDriver: config.fx.driver,
    mailDriver: config.mail.driver,
  };
}

// --- Parsers --------------------------------------------------------------

function pickEnum<T extends string>(
  raw: string | undefined,
  allowed: ReadonlyArray<T>,
  fallback: T,
): T {
  const value = raw?.trim().toLowerCase();
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function asBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function asInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function assertNotDemoInProduction(config: AppConfig, servingDemo: boolean): void {
  if (config.isProduction && servingDemo) {
    throw new AppError('ERROR_DEMO_FIXTURES_IN_PRODUCTION', {
      internalNote: 'A provider resolved to the demo fixture adapter in production',
    });
  }
}
