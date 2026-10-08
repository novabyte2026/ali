import { createHash, randomBytes } from 'node:crypto';
import { AppError, hashToken, newId, safeEqual } from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';

/**
 * Google sign-in, authorization-code flow with PKCE.
 *
 * Choices worth stating:
 *
 *   - PKCE even though this is a confidential client. It costs one hash and it
 *     removes the authorization code as a useful thing to steal.
 *   - The `state` value is stored server-side as a hash and compared in
 *     constant time, so neither a leaked log nor a timing signal helps an
 *     attacker forge a callback.
 *   - The code verifier never travels through the browser. It lives in
 *     `oauth_transactions`, keyed by the state hash.
 *   - `redirect_after` is validated against our own public web URL before
 *     being stored, so the sign-in flow cannot be turned into an open
 *     redirect.
 *   - The ID token's signature is not trusted for identity. We exchange the
 *     code over TLS to Google's token endpoint and read the subject from that
 *     direct response, which avoids shipping a JWKS verifier for no gain.
 */

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface GoogleAuthService {
  readonly configured: boolean;
  beginAuthorization(redirectAfter: string | null): Promise<{
    readonly authorizationUrl: string;
    readonly state: string;
  }>;
  completeAuthorization(args: {
    readonly state: string;
    readonly code: string;
  }): Promise<{
    readonly userId: string;
    readonly isNewUser: boolean;
    readonly redirectAfter: string | null;
  }>;
  deleteExpiredTransactions(): Promise<number>;
}

export function createGoogleAuthService(
  db: Database,
  config: AppConfig,
  log: Logger,
): GoogleAuthService {
  const salt = config.session.secret;

  return {
    configured: config.google.configured,

    async beginAuthorization(redirectAfter: string | null) {
      if (!config.google.configured) {
        throw new AppError('ERROR_SOURCE_NOT_CONFIGURED', {
          details: { provider: 'google' },
          internalNote: 'Google OAuth credentials are not configured',
        });
      }

      const state = randomBytes(32).toString('base64url');
      const codeVerifier = randomBytes(64).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

      await db.query(
        `INSERT INTO oauth_transactions (state_hash, code_verifier, redirect_after, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [
          hashToken(state, salt),
          codeVerifier,
          sanitizeRedirect(redirectAfter, config.http.publicWebUrl),
          new Date(Date.now() + TRANSACTION_TTL_MS),
        ],
      );

      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('client_id', config.google.clientId);
      url.searchParams.set('redirect_uri', config.google.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      // We do not need offline access: there is no Google API we call on the
      // user's behalf after sign-in, so asking for a refresh token would be
      // requesting more than the product uses.
      url.searchParams.set('access_type', 'online');
      url.searchParams.set('prompt', 'select_account');

      return { authorizationUrl: url.toString(), state };
    },

    async completeAuthorization({ state, code }) {
      if (!config.google.configured) {
        throw new AppError('ERROR_SOURCE_NOT_CONFIGURED', { details: { provider: 'google' } });
      }

      const stateHash = hashToken(state, salt);
      const transaction = await db.query<{
        state_hash: string;
        code_verifier: string;
        redirect_after: string | null;
        expires_at: Date;
      }>(
        `DELETE FROM oauth_transactions
          WHERE state_hash = $1
          RETURNING state_hash, code_verifier, redirect_after, expires_at`,
        [stateHash],
      );

      const row = transaction.rows[0];
      // Single-use by construction: the DELETE … RETURNING means a replayed
      // callback finds nothing.
      if (!row || !safeEqual(row.state_hash, stateHash)) {
        throw new AppError('ERROR_OAUTH_STATE_MISMATCH');
      }
      if (row.expires_at.getTime() < Date.now()) {
        throw new AppError('ERROR_AUTH_EXPIRED', { details: { stage: 'oauth_transaction' } });
      }

      const tokens = await exchangeCode(code, row.code_verifier, config, log);
      const identity = await fetchUserInfo(tokens.accessToken, log);

      if (!identity.emailVerified) {
        // An unverified Google address is not proof of control of the mailbox,
        // and we key accounts on e-mail.
        throw new AppError('ERROR_OAUTH_PROVIDER_REFUSED', {
          details: { reason: 'EMAIL_NOT_VERIFIED' },
        });
      }

      const linked = await linkOrCreateUser(db, config, identity);
      return { ...linked, redirectAfter: row.redirect_after };
    },

    async deleteExpiredTransactions(): Promise<number> {
      const result = await db.query('DELETE FROM oauth_transactions WHERE expires_at < now()');
      return result.rowCount ?? 0;
    },
  };
}

interface GoogleIdentity {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly picture: string | null;
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  config: AppConfig,
  log: Logger,
): Promise<{ readonly accessToken: string }> {
  const body = new URLSearchParams({
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: config.google.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    // The body can contain the client secret echoed back in some error cases,
    // so it is never logged.
    log.warn('Google token exchange failed', { status: response.status });
    throw new AppError('ERROR_OAUTH_PROVIDER_REFUSED', {
      details: { stage: 'token_exchange' },
    });
  }

  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new AppError('ERROR_OAUTH_PROVIDER_REFUSED', { details: { stage: 'no_access_token' } });
  }

  return { accessToken: payload.access_token };
}

async function fetchUserInfo(accessToken: string, log: Logger): Promise<GoogleIdentity> {
  const response = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    log.warn('Google userinfo failed', { status: response.status });
    throw new AppError('ERROR_OAUTH_PROVIDER_REFUSED', { details: { stage: 'userinfo' } });
  }

  const payload = (await response.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  if (!payload.sub || !payload.email) {
    throw new AppError('ERROR_OAUTH_PROVIDER_REFUSED', { details: { stage: 'incomplete_profile' } });
  }

  return {
    subject: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: payload.name ?? null,
    // Only an https avatar is accepted, and it is rendered through our own
    // image handling rather than hot-linked into a privileged context.
    picture: payload.picture?.startsWith('https://') ? payload.picture : null,
  };
}

/**
 * Links a Google identity to a user, creating one if needed.
 *
 * Matching on verified e-mail is what allows an existing account to be reached
 * after a Google subject change, and the subject is then recorded so later
 * sign-ins match on the stable identifier rather than on an address that can
 * be reassigned.
 */
async function linkOrCreateUser(
  db: Database,
  config: AppConfig,
  identity: GoogleIdentity,
): Promise<{ readonly userId: string; readonly isNewUser: boolean }> {
  return db.tx(async (client) => {
    const existingIdentity = await client.query<{ user_id: string }>(
      `SELECT user_id FROM user_identities
        WHERE provider = 'google' AND provider_subject = $1`,
      [identity.subject],
    );

    const byIdentity = existingIdentity.rows[0];
    if (byIdentity) {
      await client.query(
        `UPDATE user_identities SET last_login_at = now(), email_at_provider = $2
          WHERE provider = 'google' AND provider_subject = $1`,
        [identity.subject, identity.email],
      );
      await client.query('UPDATE users SET last_seen_at = now() WHERE user_id = $1', [
        byIdentity.user_id,
      ]);
      return { userId: byIdentity.user_id, isNewUser: false };
    }

    const existingUser = await client.query<{ user_id: string }>(
      `SELECT user_id FROM users WHERE email_normalized = $1 AND deleted_at IS NULL`,
      [identity.email],
    );

    const byEmail = existingUser.rows[0];
    if (byEmail) {
      await client.query(
        `INSERT INTO user_identities
           (identity_id, user_id, provider, provider_subject, email_at_provider, last_login_at)
         VALUES ($1, $2, 'google', $3, $4, now())`,
        [newId('uid'), byEmail.user_id, identity.subject, identity.email],
      );
      await client.query('UPDATE users SET last_seen_at = now() WHERE user_id = $1', [
        byEmail.user_id,
      ]);
      return { userId: byEmail.user_id, isNewUser: false };
    }

    // New account. The admin allowlist is the only route to the admin role;
    // there is no self-service escalation.
    const role = config.adminEmails.includes(identity.email) ? 'admin' : 'user';
    const userId = newId('usr');
    const country = config.integrations.aliexpress.defaultCountry || 'IL';

    await client.query(
      `INSERT INTO users
         (user_id, email, display_name, avatar_url, role, locale, country_code, currency, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        userId,
        identity.email,
        identity.name,
        identity.picture,
        role,
        'he',
        country,
        country === 'IL' ? 'ILS' : 'USD',
      ],
    );

    await client.query(
      `INSERT INTO user_identities
         (identity_id, user_id, provider, provider_subject, email_at_provider, last_login_at)
       VALUES ($1, $2, 'google', $3, $4, now())`,
      [newId('uid'), userId, identity.subject, identity.email],
    );

    // Records the state the account starts in, which is everything off.
    for (const kind of [
      'store_search_history',
      'personalized_ranking',
      'product_analytics',
      'marketing_emails',
    ]) {
      await client.query(
        `INSERT INTO user_consents (consent_id, user_id, consent_kind, granted, source)
         VALUES ($1, $2, $3, FALSE, 'account_created_default')`,
        [newId('con'), userId, kind],
      );
    }

    return { userId, isNewUser: true };
  });
}

/**
 * Validates a post-sign-in redirect. Only a path on our own web origin is
 * accepted; anything else returns null and the user lands on the home page.
 */
function sanitizeRedirect(candidate: string | null, publicWebUrl: string): string | null {
  if (!candidate) return null;
  // A bare path is the normal case.
  if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    return candidate.slice(0, 500);
  }
  try {
    const parsed = new URL(candidate);
    const allowed = new URL(publicWebUrl);
    if (parsed.origin !== allowed.origin) return null;
    return `${parsed.pathname}${parsed.search}`.slice(0, 500);
  } catch {
    return null;
  }
}
