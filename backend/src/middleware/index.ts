import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type Permission,
  type Principal,
  type UserProfile,
  AppError,
  isAppError,
  isExpectedError,
  newId,
  toAppError,
} from '@shelf/shared';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';
import type { SessionService } from '../auth/session.js';
import type { Cache } from '../cache/index.js';

/**
 * Request-scoped identity, authorization and error handling.
 *
 * The rule this file exists to enforce is rule 84: a frontend guard is not a
 * guard. Every non-public route calls `requirePermission`, which checks the
 * server-side principal. A guest who hand-crafts a POST to /api/v1/alerts gets
 * 401 from here, not from the absence of a button.
 */

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
    profile: UserProfile | null;
    requestId: string;
    startedAt: number;
  }
}

export interface MiddlewareDeps {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly sessions: SessionService;
  readonly cache: Cache;
}

export function registerMiddleware(app: FastifyInstance, deps: MiddlewareDeps): void {
  const { config, log, sessions } = deps;

  // --- Request id and timing ---------------------------------------------
  app.addHook('onRequest', async (request) => {
    request.requestId = newId('req');
    request.startedAt = Date.now();
    // Echoed so a user reporting a problem can quote it and an operator can
    // find the exact request in the logs.
    void request;
  });

  // --- Identity ----------------------------------------------------------
  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[config.session.cookieName];

    if (!token) {
      request.principal = sessions.guestPrincipal(undefined);
      request.profile = null;
      return;
    }

    const resolved = await sessions.resolve(token);
    if (!resolved) {
      // An expired or revoked cookie is cleared so the browser stops sending
      // it, and the request continues as a guest rather than failing.
      reply.clearCookie(config.session.cookieName, { path: '/' });
      request.principal = sessions.guestPrincipal(token);
      request.profile = null;
      return;
    }

    request.principal = resolved.principal;
    request.profile = resolved.profile;

    if (resolved.needsRotation) {
      try {
        const rotated = await sessions.rotate(resolved.sessionId);
        setSessionCookie(reply, config, rotated.token, rotated.expiresAt);
      } catch (error) {
        // Rotation failing must not log the user out mid-request.
        log.warn('Session rotation failed', { error });
      }
    }
  });

  // --- Security headers ---------------------------------------------------
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.requestId);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'DENY');
    // The API serves JSON and SSE only; nothing it returns should ever be
    // treated as a document by a browser.
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cross-origin-resource-policy', 'same-site');
    return payload;
  });

  // --- Access log ---------------------------------------------------------
  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Date.now() - request.startedAt;
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    log[level]('request', {
      requestId: request.requestId,
      method: request.method,
      // The routerPath is the pattern, not the populated URL, so ids and
      // query strings stay out of the access log.
      route: request.routeOptions?.url ?? request.url.split('?')[0],
      status: reply.statusCode,
      durationMs,
      role: request.principal?.role ?? 'guest',
    });
  });

  // --- Errors -------------------------------------------------------------
  app.setErrorHandler((error, request, reply) => {
    const appError = normalizeError(error);

    if (isExpectedError(appError.code)) {
      log.warn('request failed', {
        requestId: request.requestId,
        code: appError.code,
        route: request.routeOptions?.url,
      });
    } else {
      log.error('request failed', {
        requestId: request.requestId,
        code: appError.code,
        route: request.routeOptions?.url,
        note: appError.internalNote,
        error: appError.cause instanceof Error ? appError.cause : undefined,
      });
    }

    // Nothing from the exception reaches the client: no message, no stack, no
    // driver detail. Only a code, a translation key and the request id.
    reply.status(appError.status).send(appError.toPublicJSON(request.requestId));
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send(new AppError('ERROR_NOT_FOUND').toPublicJSON(request.requestId ?? 'unknown'));
  });
}

/**
 * Translates framework and validation errors into our taxonomy before the
 * error handler sees them.
 */
function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  const candidate = error as {
    validation?: unknown;
    statusCode?: number;
    code?: string;
    message?: string;
  };

  if (candidate.validation) {
    return new AppError('ERROR_VALIDATION', {
      internalNote: candidate.message ?? 'schema validation failed',
      cause: error,
    });
  }

  if (candidate.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || candidate.statusCode === 413) {
    return new AppError('ERROR_PAYLOAD_TOO_LARGE', { cause: error });
  }

  if (candidate.statusCode === 429) {
    return new AppError('ERROR_RATE_LIMIT', { cause: error });
  }

  return toAppError(error);
}

// --- Authorization --------------------------------------------------------

/**
 * The server-side gate. Attach to any route that is not public.
 *
 * A guest hitting a user route gets ERROR_GUEST_FEATURE_REQUIRES_ACCOUNT,
 * which the frontend turns into a sign-in prompt rather than a generic
 * "forbidden" — the distinction is the difference between a dead end and an
 * invitation.
 */
export function requirePermission(permission: Permission) {
  return async function guard(request: FastifyRequest): Promise<void> {
    const principal = request.principal;

    if (!principal.permissions.includes(permission)) {
      if (principal.kind === 'guest') {
        throw new AppError('ERROR_GUEST_FEATURE_REQUIRES_ACCOUNT', {
          details: { permission },
        });
      }
      throw new AppError('ERROR_FORBIDDEN', { details: { permission } });
    }
  };
}

/** Requires a signed-in user, regardless of permission. */
export async function requireUser(request: FastifyRequest): Promise<void> {
  if (request.principal.kind !== 'user') {
    throw new AppError('ERROR_AUTH_REQUIRED');
  }
}

export function requireAdmin() {
  return async function guard(request: FastifyRequest): Promise<void> {
    if (request.principal.kind !== 'user' || request.principal.role !== 'admin') {
      // Deliberately a 404-shaped answer for non-admins would be nicer for
      // obscurity, but a clear 403 is better for an operator debugging their
      // own access. The admin routes are not secret, only restricted.
      throw new AppError('ERROR_FORBIDDEN', { details: { requires: 'admin' } });
    }
  };
}

export function userIdOf(request: FastifyRequest): string {
  if (request.principal.kind !== 'user') throw new AppError('ERROR_AUTH_REQUIRED');
  return request.principal.userId;
}

export function sessionKeyOf(request: FastifyRequest): string {
  return request.principal.kind === 'user'
    ? `user:${request.principal.userId}`
    : `guest:${request.principal.sessionHash}`;
}

// --- Rate limiting --------------------------------------------------------

/**
 * Token-bucket rate limiting, keyed on the principal rather than the IP.
 *
 * IP keying punishes shared networks — a university or an office behind one
 * address — and is trivially evaded. Keying on the session means a guest gets
 * their own budget, and the budget survives an IP change.
 */
export function rateLimit(deps: MiddlewareDeps, options: { readonly perMinute: number; readonly bucket: string }) {
  return async function limiter(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const key = `rl:${options.bucket}:${sessionKeyOf(request)}:${currentMinute()}`;

    const current = (await deps.cache.get<number>(key)) ?? 0;
    if (current >= options.perMinute) {
      reply.header('retry-after', '60');
      throw new AppError('ERROR_RATE_LIMIT', {
        details: { limit: options.perMinute, window: '1m' },
      });
    }

    // Counter TTL is two minutes so a bucket spanning a minute boundary does
    // not expire mid-window.
    await deps.cache.set(key, current + 1, 120);
  };
}

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

// --- Cookies --------------------------------------------------------------

export function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(config.session.cookieName, token, {
    path: '/',
    httpOnly: true,
    secure: config.session.cookieSecure,
    // Lax rather than Strict: the OAuth callback is a cross-site navigation
    // back to us, and Strict would drop the cookie on arrival.
    sameSite: 'lax',
    expires: expiresAt,
    signed: false,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.session.cookieName, {
    path: '/',
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: 'lax',
  });
}

/** Device class from the user agent, for analytics. Not stored verbatim. */
export function deviceTypeOf(request: FastifyRequest): 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN' {
  const agent = request.headers['user-agent'];
  if (!agent) return 'UNKNOWN';
  const lower = agent.toLowerCase();
  if (lower.includes('ipad') || lower.includes('tablet')) return 'TABLET';
  if (lower.includes('mobi') || lower.includes('android')) return 'MOBILE';
  return 'DESKTOP';
}
