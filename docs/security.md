# Security and privacy

Security here is mostly about restraint: the product collects little, separates
what it does collect, and enforces its boundaries on the server. A comparison
engine does not need a behavioural profile to work, so it does not build one by
default.

## Sessions

- Sign-in is Google OAuth 2.0, **authorization-code with PKCE** and a bound
  `state` parameter (checked on callback — a mismatch is
  `ERROR_OAUTH_STATE_MISMATCH`).
- A session is an **opaque, rotating** token in an HTTP-only cookie
  (`shelf_session`). The database stores **only a salted SHA-256 hash** of the
  token, never the token itself, so a database leak does not hand over live
  sessions.
- Sessions expire after `SESSION_TTL_HOURS` and can be revoked individually
  (`/api/v1/auth/signout`) or all at once (`/api/v1/auth/signout-all`).
- In production set `SESSION_COOKIE_SECURE=true`; the cookie is then sent only
  over HTTPS.

## Authorization

Three roles — guest, user, admin — enforced **on the server**. Every non-public
route runs a `requireUser` + `requirePermission(...)` preHandler. A guest calling
a protected route directly, bypassing the UI, gets `401 ERROR_AUTH_REQUIRED`;
the e2e suite proves this by calling the endpoints with no cookie. The guest
limitation is additionally a **data-model boundary**: a guest owns no rows in any
user-feature table, so there is nothing to leak even if a check were missed.

Admin is granted only to e-mails in `ADMIN_EMAILS`, and every admin mutation
(policy change, kill switch, provider enable/disable, capability review) is
written to `audit_logs` with who, what and when.

## Privacy defaults

The defaults are the minimum, and they are set in the schema, not just the UI:

- **Search history is off by default.** It is stored only if the user turns it
  on.
- **Personalized ranking is off by default.**
- **Product analytics is off by default**; events are session-scoped unless the
  user consents to user-scoped analytics.

Users have granular consent controls (`PATCH /api/v1/me/privacy`), can **export**
everything the account holds (`GET /api/v1/me/export`), and can **delete** the
account and all its data (`POST /api/v1/me/delete`).

## Data separation

Three kinds of data live in separate tables with separate retention, so one
concern cannot bleed into another:

| Data | Table | Key | Retention |
| ---- | ----- | --- | --------- |
| Affiliate clicks | `affiliate_clicks` | rotating session hash (+ optional user id) | swept on schedule |
| Product analytics | `analytics_events` | session hash only (user id only with consent) | swept on schedule |
| Personal data | user-owned tables | user id | deleted with the user |

Neither the click nor the analytics table stores an IP address or a user-agent
string in the clear. The `retention-sweep` worker enforces the windows. Analytics
ingest is allowlisted: only known properties per event type are kept, and
anything else is dropped at the door (`POST /api/v1/analytics/events`).

## Provider content and data

Before the system retains an image, review text or a raw payload, the adapter's
`validateContentUsage(usage, kind)` decides whether that use is permitted for
that provider. A restriction is therefore applied where data enters the system,
not remembered at render time. Persisting provider data at all requires the
`persistProviderData` capability to be `AVAILABLE`; where it is not, price and
shipping observations are simply not stored, and the history-based features are
honestly thinner rather than faked.

## Error hygiene

Error responses are a fixed envelope: `code`, `messageKey`, `details`,
`retryable`, `requestId`. They never contain a stack trace, a `node_modules`
path or a raw exception message — asserted by the e2e suite. The user-facing
sentence is resolved client-side from `messageKey`, so the server ships a stable
code, not prose, and nothing internal leaks through an error.

## Secret handling

- Secrets live in `.env`, which is git-ignored. Only `NEXT_PUBLIC_*` values
  reach the browser bundle; nothing else does.
- `DATABASE_URL` is read from the environment, never passed as a CLI argument, so
  a password cannot land in shell history or a process listing.
- Session tokens, provider secrets, IPs and user-agents never appear in logs.
- The backend validates configuration at boot and fails fast rather than running
  half-configured (missing `SESSION_SECRET`, demo fixtures in production, a
  provider enabled without complete credentials).

## Input validation

- Queries below the minimum length are rejected (`ERROR_QUERY_TOO_SHORT`).
- Unsupported source / country / currency values are typed errors, never a
  guessed fallback.
- Payload size is bounded (`ERROR_PAYLOAD_TOO_LARGE`).
- Rate limits apply per session (`ERROR_RATE_LIMIT`) and per provider
  (`ERROR_PROVIDER_RATE_LIMIT`).
- Pasted product URLs are parsed offline (`recognizeUrl` fetches nothing); a
  malformed one is `ERROR_INVALID_PRODUCT_URL`.
