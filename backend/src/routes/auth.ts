import type { FastifyInstance } from 'fastify';
import { AppError } from '@shelf/shared';
import type { AppContext } from '../context.js';
import {
  clearSessionCookie,
  rateLimit,
  requireUser,
  setSessionCookie,
  userIdOf,
} from '../middleware/index.js';

/**
 * Authentication routes.
 *
 * The flow deliberately keeps the browser out of the security-sensitive parts:
 * the PKCE verifier stays server-side, the state value is compared as a hash,
 * and the session token is set as an httpOnly cookie that JavaScript cannot
 * read. The frontend never handles a token.
 */

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const authLimiter = rateLimit(
    { config: ctx.config, log: ctx.log, sessions: ctx.sessions, cache: ctx.cache },
    { perMinute: Math.max(1, Math.floor(ctx.config.rateLimits.authPerHourPerIp / 60) + 2), bucket: 'auth' },
  );

  /** Current identity. Always answers, describing a guest as a guest. */
  app.get('/api/v1/auth/me', async (request) => {
    if (request.principal.kind === 'guest') {
      return {
        authenticated: false,
        role: 'guest',
        permissions: request.principal.permissions,
        signInAvailable: ctx.google.configured,
      };
    }

    return {
      authenticated: true,
      role: request.principal.role,
      permissions: request.principal.permissions,
      profile: request.profile,
      signInAvailable: true,
    };
  });

  app.get(
    '/api/v1/auth/google/start',
    { preHandler: [authLimiter] },
    async (request, reply) => {
      if (!ctx.google.configured) {
        throw new AppError('ERROR_SOURCE_NOT_CONFIGURED', {
          details: { provider: 'google' },
        });
      }

      const redirectAfter = (request.query as { redirect?: string }).redirect ?? null;
      const { authorizationUrl } = await ctx.google.beginAuthorization(redirectAfter);

      // Returned rather than redirected, so the frontend controls the
      // navigation and can show its own "taking you to Google" state.
      return reply.send({ authorizationUrl });
    },
  );

  app.get(
    '/api/v1/auth/google/callback',
    { preHandler: [authLimiter] },
    async (request, reply) => {
      const query = request.query as { code?: string; state?: string; error?: string };

      if (query.error) {
        // The user declined at Google. Not an error to log loudly.
        return reply.redirect(`${ctx.config.http.publicWebUrl}/?signin=cancelled`);
      }
      if (!query.code || !query.state) {
        throw new AppError('ERROR_VALIDATION', { details: { field: 'code,state' } });
      }

      const result = await ctx.google.completeAuthorization({
        state: query.state,
        code: query.code,
      });

      const session = await ctx.sessions.create({
        userId: result.userId,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
        ...(request.ip ? { ip: request.ip } : {}),
      });

      setSessionCookie(reply, ctx.config, session.token, session.expiresAt);

      const target = result.redirectAfter ?? (result.isNewUser ? '/account?welcome=1' : '/');
      return reply.redirect(`${ctx.config.http.publicWebUrl}${target}`);
    },
  );

  app.post('/api/v1/auth/signout', async (request, reply) => {
    if (request.principal.kind === 'user') {
      await ctx.sessions.revoke(request.principal.sessionId, 'user_signout');
    }
    clearSessionCookie(reply, ctx.config);
    return { signedOut: true };
  });

  /** Signs out everywhere. The control people look for after losing a device. */
  app.post(
    '/api/v1/auth/signout-all',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const revoked = await ctx.sessions.revokeAllForUser(userIdOf(request), 'user_signout_all');
      clearSessionCookie(reply, ctx.config);
      return { signedOut: true, sessionsRevoked: revoked };
    },
  );
}
