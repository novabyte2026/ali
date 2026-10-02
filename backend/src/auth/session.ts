import { randomBytes } from 'node:crypto';
import {
  type Permission,
  type Principal,
  type Role,
  type UserProfile,
  AppError,
  ROLE_PERMISSIONS,
  hashToken,
  newId,
  sessionHash,
} from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';

/**
 * Sessions.
 *
 * Opaque random tokens, not JWTs. The reason is revocation: a signed token
 * cannot be withdrawn before it expires without a server-side denylist, which
 * is a session table with extra steps. With an opaque token, signing out
 * actually signs you out, and an operator can revoke a compromised session
 * immediately.
 *
 * Only a salted hash of the token is stored, so a database leak does not hand
 * over live sessions. Tokens rotate on a schedule, and a replayed rotated
 * token is detectable (the row records what it was rotated to) rather than
 * merely invalid — which is the signal that a token was stolen.
 */

const TOKEN_BYTES = 32;
/** Rotate a session token roughly daily during active use. */
const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SessionService {
  create(args: {
    readonly userId: string;
    readonly userAgent?: string;
    readonly ip?: string;
  }): Promise<{ readonly token: string; readonly sessionId: string; readonly expiresAt: Date }>;

  resolve(token: string): Promise<ResolvedSession | null>;

  /** Replaces a session's token, returning the new one. */
  rotate(
    sessionId: string,
  ): Promise<{ readonly token: string; readonly sessionId: string; readonly expiresAt: Date }>;

  revoke(sessionId: string, reason: string): Promise<void>;
  revokeAllForUser(userId: string, reason: string): Promise<number>;
  /** Pseudonymous id for a guest, for rate limiting and analytics. */
  guestPrincipal(rawSessionCookie: string | undefined): Principal;
  deleteExpired(): Promise<number>;
}

export interface ResolvedSession {
  readonly principal: Principal;
  readonly profile: UserProfile;
  readonly sessionId: string;
  readonly needsRotation: boolean;
}

export function createSessionService(
  db: Database,
  config: AppConfig,
  log: Logger,
): SessionService {
  const salt = config.session.secret;

  async function issue(userId: string, userAgent?: string, ip?: string) {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const sessionId = newId('ses');
    const expiresAt = new Date(Date.now() + config.session.ttlHours * 3600_000);

    await db.query(
      `INSERT INTO sessions
         (session_id, user_id, token_hash, user_agent_hash, ip_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sessionId,
        userId,
        hashToken(token, salt),
        // Hashed, not stored: useful for spotting a session used from a new
        // device, useless for building a profile.
        userAgent ? hashToken(userAgent, salt).slice(0, 32) : null,
        ip ? hashToken(ip, salt).slice(0, 32) : null,
        expiresAt,
      ],
    );

    return { token, sessionId, expiresAt };
  }

  return {
    create: ({ userId, userAgent, ip }) => issue(userId, userAgent, ip),

    async resolve(token: string): Promise<ResolvedSession | null> {
      if (!token || token.length < 16) return null;

      const result = await db.query<SessionRow>(
        `SELECT s.session_id, s.user_id, s.expires_at, s.revoked_at, s.rotated_to,
                s.last_used_at, s.created_at,
                u.email, u.display_name, u.avatar_url, u.role,
                u.locale, u.country_code, u.currency, u.default_source_mode,
                u.default_sort, u.reduced_motion,
                u.store_search_history, u.personalized_ranking,
                u.product_analytics, u.marketing_emails,
                u.email_alerts, u.in_app_alerts, u.deal_digest,
                u.created_at AS user_created_at, u.deleted_at
           FROM sessions s
           JOIN users u ON u.user_id = s.user_id
          WHERE s.token_hash = $1`,
        [hashToken(token, salt)],
      );

      const row = result.rows[0];
      if (!row) return null;

      if (row.deleted_at) return null;

      if (row.revoked_at) {
        // A revoked token still being presented is worth noticing: if it was
        // rotated, this is a replay of the old token.
        if (row.rotated_to) {
          log.warn('Rotated session token replayed', { sessionId: row.session_id });
        }
        return null;
      }

      if (row.expires_at.getTime() <= Date.now()) return null;

      // Touch, but not on every request: a write per request on a hot endpoint
      // is pure contention for a field nothing reads in real time.
      if (Date.now() - row.last_used_at.getTime() > 300_000) {
        void db
          .query('UPDATE sessions SET last_used_at = now() WHERE session_id = $1', [
            row.session_id,
          ])
          .catch(() => undefined);
      }

      const role = row.role as Role;
      const principal: Principal = {
        kind: 'user',
        userId: row.user_id,
        sessionId: row.session_id,
        role,
        permissions: ROLE_PERMISSIONS[role] as ReadonlyArray<Permission>,
        email: row.email,
      };

      return {
        principal,
        profile: toProfile(row),
        sessionId: row.session_id,
        needsRotation: Date.now() - row.created_at.getTime() > ROTATE_AFTER_MS,
      };
    },

    async rotate(sessionId: string) {
      const existing = await db.query<{ user_id: string }>(
        'SELECT user_id FROM sessions WHERE session_id = $1 AND revoked_at IS NULL',
        [sessionId],
      );
      const row = existing.rows[0];
      if (!row) throw new AppError('ERROR_AUTH_EXPIRED');

      const issued = await issue(row.user_id);
      await db.query(
        `UPDATE sessions
            SET revoked_at = now(), revoked_reason = 'rotated', rotated_to = $2
          WHERE session_id = $1`,
        [sessionId, issued.sessionId],
      );
      return issued;
    },

    async revoke(sessionId: string, reason: string): Promise<void> {
      await db.query(
        `UPDATE sessions
            SET revoked_at = now(), revoked_reason = $2
          WHERE session_id = $1 AND revoked_at IS NULL`,
        [sessionId, reason.slice(0, 200)],
      );
    },

    async revokeAllForUser(userId: string, reason: string): Promise<number> {
      const result = await db.query(
        `UPDATE sessions
            SET revoked_at = now(), revoked_reason = $2
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId, reason.slice(0, 200)],
      );
      return result.rowCount ?? 0;
    },

    /**
     * A guest principal.
     *
     * Guests get a pseudonymous hash derived from whatever opaque cookie value
     * the browser already carries, so rate limiting and analytics can group a
     * session's requests without us issuing an identifier whose purpose is
     * tracking. With no cookie at all, a random per-request hash means the
     * request is rate limited on its own.
     */
    guestPrincipal(rawSessionCookie: string | undefined): Principal {
      const basis = rawSessionCookie ?? randomBytes(16).toString('hex');
      return {
        kind: 'guest',
        sessionHash: sessionHash(basis, salt),
        role: 'guest',
        permissions: ROLE_PERMISSIONS.guest as ReadonlyArray<Permission>,
      };
    },

    async deleteExpired(): Promise<number> {
      const result = await db.query(
        `DELETE FROM sessions
          WHERE expires_at < now() - INTERVAL '30 days'
             OR (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '30 days')`,
      );
      return result.rowCount ?? 0;
    },
  };
}

function toProfile(row: SessionRow): UserProfile {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role as Role,
    preferences: {
      locale: row.locale as 'he' | 'en',
      countryCode: row.country_code,
      currency: row.currency,
      defaultSourceMode: row.default_source_mode,
      defaultSort: row.default_sort as UserProfile['preferences']['defaultSort'],
      reducedMotion: row.reduced_motion,
    },
    privacy: {
      storeSearchHistory: row.store_search_history,
      personalizedRanking: row.personalized_ranking,
      productAnalytics: row.product_analytics,
      marketingEmails: row.marketing_emails,
    },
    notifications: {
      emailAlerts: row.email_alerts,
      inAppAlerts: row.in_app_alerts,
      dealDigest: row.deal_digest as UserProfile['notifications']['dealDigest'],
    },
    createdAt: row.user_created_at.toISOString(),
  };
}

interface SessionRow {
  session_id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_to: string | null;
  last_used_at: Date;
  created_at: Date;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
  locale: string;
  country_code: string;
  currency: string;
  default_source_mode: string;
  default_sort: string;
  reduced_motion: boolean;
  store_search_history: boolean;
  personalized_ranking: boolean;
  product_analytics: boolean;
  marketing_emails: boolean;
  email_alerts: boolean;
  in_app_alerts: boolean;
  deal_digest: string;
  user_created_at: Date;
  deleted_at: Date | null;
}
