# API reference

Base URL: `${PUBLIC_API_URL}` (default `http://localhost:4000`). All application
endpoints are under `/api/v1`. The API speaks JSON; the one exception is the
streaming search endpoint, which is Server-Sent Events.

## Authentication and roles

Authentication is a rotating opaque session cookie (`shelf_session`), set after
Google OAuth sign-in. There are three roles:

- **guest** — no account. Can use all public endpoints (search, product detail,
  coupons, deals feed, affiliate links, meta). Cannot use any `/me/*` endpoint
  or create a deal radar.
- **user** — signed in. Adds favourites, saved searches, alerts, carts, history,
  export and deletion.
- **admin** — a user whose e-mail is in `ADMIN_EMAILS`. Adds the admin console.

Every non-public route runs a `requireUser` + `requirePermission(...)`
preHandler. Authorization is enforced **server-side**: a guest calling a
protected route directly (not through the UI) gets `401` with code
`ERROR_AUTH_REQUIRED`, which the e2e suite proves by calling the endpoints with
no cookie.

## The error envelope

Every error — validation, auth, policy, provider — comes back in one shape and
nothing else:

```json
{
  "error": {
    "code": "ERROR_QUERY_TOO_SHORT",
    "messageKey": "errors.query_too_short",
    "details": { "minLength": 2 },
    "retryable": false,
    "requestId": "req_3cc651e687cd44e1a28e1fee1d83eccd"
  }
}
```

- `code` — a stable machine code (see the table below).
- `messageKey` — an i18n key; the client renders the Hebrew or English string.
  The server never ships a user-facing sentence, so the message is always in the
  user's language.
- `details` — structured, safe-to-show context. Never a stack trace.
- `retryable` — whether retrying could succeed (a source timeout) or not (a
  validation error).
- `requestId` — correlates the response with the structured server log.

Error bodies never contain a stack frame, a `node_modules` path or a raw
exception message. This is asserted in the e2e suite.

### Error codes

Auth: `ERROR_AUTH_REQUIRED`, `ERROR_AUTH_INVALID`, `ERROR_AUTH_EXPIRED`,
`ERROR_FORBIDDEN`, `ERROR_GUEST_FEATURE_REQUIRES_ACCOUNT`,
`ERROR_OAUTH_STATE_MISMATCH`, `ERROR_OAUTH_PROVIDER_REFUSED`.

Request: `ERROR_VALIDATION`, `ERROR_QUERY_TOO_SHORT`, `ERROR_NOT_FOUND`,
`ERROR_CONFLICT`, `ERROR_PAYLOAD_TOO_LARGE`, `ERROR_RATE_LIMIT`,
`ERROR_LIMIT_REACHED`, `ERROR_UNSUPPORTED_SOURCE`, `ERROR_UNSUPPORTED_COUNTRY`,
`ERROR_UNSUPPORTED_CURRENCY`, `ERROR_INVALID_PRODUCT`,
`ERROR_INVALID_PRODUCT_URL`, `ERROR_IMAGE_UNREADABLE`.

Capability / policy: `ERROR_CAPABILITY_UNAVAILABLE`,
`ERROR_CAPABILITY_VERIFICATION_REQUIRED`, `ERROR_CONTENT_USAGE_NOT_PERMITTED`,
`ERROR_POLICY_BLOCK`, `ERROR_DISCLOSURE_NOT_CONFIGURED`,
`ERROR_INVALID_AFFILIATE_LINK`, `ERROR_DATA_UNAVAILABLE`.

Source: `ERROR_SOURCE_NOT_CONFIGURED`, `ERROR_SOURCE_DISABLED`,
`ERROR_SOURCE_UNAVAILABLE`, `ERROR_SOURCE_TIMEOUT`,
`ERROR_PROVIDER_AUTH_REJECTED`, `ERROR_PROVIDER_RATE_LIMIT`,
`ERROR_PROVIDER_RESPONSE_INVALID`, `ERROR_DEPENDENCY_UNAVAILABLE`.

Platform: `ERROR_INTERNAL`, `ERROR_DEMO_FIXTURES_IN_PRODUCTION`.

## Public endpoints

### Search

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/v1/search` | Run a search, return the full result in one response. Query: `q`, `source` (`amazon`/`aliexpress`/`temu`/`all`), `country`, `currency`, plus filters and `sort`. |
| GET | `/api/v1/search/stream` | The same pipeline as Server-Sent Events: one event per real stage transition (`PARSING`, `SELECTING_SOURCES`, `QUERYING_SOURCES`, `NORMALIZING`, `MATCHING`, `PRICING`, `RANKING`), per-provider status, then results. No synthetic progress. |
| GET | `/api/v1/search/parse` | Parse a query without running it — returns the `QueryIntent` and the recognized tokens, so the UI can show "budget: ₪120 ×" chips. |
| GET | `/api/v1/search/examples` | Example queries for the empty state. Takes `locale` so Hebrew and English get language-appropriate examples. |

`q` shorter than the minimum yields `400 ERROR_QUERY_TOO_SHORT`. An unsupported
`source`, `country` or `currency` yields the matching typed error, never a
guessed fallback.

### Products

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/v1/products/:providerId/:providerProductId` | One product's normalized detail. |
| GET | `/api/v1/products/:providerId/:providerProductId/comparison` | Cross-source comparison — only for identifier-backed same-product matches. Refuses to name a cheapest when totals are not comparable. |
| GET | `/api/v1/products/:providerId/:providerProductId/cheaper` | "Find this cheaper" — same product only, variants excluded. |
| GET | `/api/v1/products/:providerId/:providerProductId/alternatives` | Similar products, clearly labelled as alternatives, not the same product. |
| POST | `/api/v1/products/analyze-url` | Paste a product URL to identify it. |
| POST | `/api/v1/products/analyze-image` | Image lookup. **Marked PLANNED** — returns `ERROR_CAPABILITY_UNAVAILABLE` rather than a guess. |

### Coupons, deals, affiliate

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/v1/coupons` | Coupons across configured sources, each with its verification state. |
| GET | `/api/v1/coupons/:providerId/:providerProductId` | Coupons applicable to a product. |
| GET | `/api/v1/deals` | The deal feed. History-based deal kinds are thinner where observation retention is not permitted. |
| GET | `/api/v1/deals/radars` | *(user)* List deal-radar subscriptions. |
| POST | `/api/v1/deals/radars` | *(user)* Create one. Refused with a reason if the chosen sources cannot support deal discovery. |
| DELETE | `/api/v1/deals/radars/:radarId` | *(user)* Remove one. |
| POST | `/api/v1/affiliate/link` | Build a disclosed, tracked outbound link for a product. Falls back to the plain store URL (untracked) when the programme is unconfigured — never a malformed tracking link. |
| POST | `/api/v1/affiliate/click` | Record an outbound click against the rotating session hash. |
| GET | `/api/v1/affiliate/transparency` | The public affiliate-disclosure statement and which sources are monetized. |

### Meta and health

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/v1/providers` | Each provider and its resolved capability states (`AVAILABLE` / `NOT_CONFIGURED` / `VERIFICATION_REQUIRED` / …). |
| GET | `/api/v1/providers/:providerId/features` | A provider's per-feature availability. |
| GET | `/api/v1/meta/disclosures` | Required disclosure strings per provider. |
| GET | `/api/v1/meta/features` | The production-readiness register. |
| GET | `/api/v1/meta/config` | Public runtime config (default locale, country, currency, enabled sources). |
| GET | `/api/v1/meta/metrics` | Lightweight operational counters. |
| GET | `/health` | Liveness — always `200` if the process is up. |
| GET | `/ready` | Readiness — `200` only when the database is reachable. |
| POST | `/api/v1/analytics/events` | Ingest a client analytics event. Only allowlisted properties are kept; anything else is dropped on ingest. |

## Auth endpoints

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/v1/auth/me` | Describes the caller — `{ authenticated, role }`. A guest gets `200` with `role: "guest"`, not an error. |
| GET | `/api/v1/auth/google/start` | Begin the OAuth flow (PKCE + state). |
| GET | `/api/v1/auth/google/callback` | OAuth redirect target. |
| POST | `/api/v1/auth/signout` | Revoke the current session. |
| POST | `/api/v1/auth/signout-all` | Revoke every session for the user. |

## User endpoints (role: user)

All require a session; a guest gets `401 ERROR_AUTH_REQUIRED`.

| Method | Path |
| ------ | ---- |
| GET | `/api/v1/me/profile` |
| PATCH | `/api/v1/me/preferences` |
| PATCH | `/api/v1/me/privacy` |
| GET / POST | `/api/v1/me/favorites` |
| DELETE | `/api/v1/me/favorites/:favoriteId` |
| GET / POST | `/api/v1/me/saved-searches` |
| DELETE | `/api/v1/me/saved-searches/:savedSearchId` |
| GET / POST | `/api/v1/me/alerts` |
| DELETE | `/api/v1/me/alerts/:alertId` |
| GET / POST | `/api/v1/me/carts` |
| GET | `/api/v1/me/carts/:cartId` |
| POST | `/api/v1/me/carts/:cartId/lines` |
| PATCH / DELETE | `/api/v1/me/carts/:cartId/lines/:lineId` |
| DELETE | `/api/v1/me/carts/:cartId` |
| GET / DELETE | `/api/v1/me/history` |
| GET | `/api/v1/me/export` — download everything the account holds. |
| POST | `/api/v1/me/delete` — delete the account and all its data. |

Creating an alert is capability-gated per kind and per provider: an alert whose
provider does not permit, say, price history is refused at creation with the
reason, not accepted and silently never fired.

## Admin endpoints (role: admin)

A guest or ordinary user gets `401` / `403`.

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/v1/admin/compliance` | Policy versions, verification backlog, warning counts per provider. |
| GET | `/api/v1/admin/compliance/:providerId` | One provider's policy and capability states. |
| POST | `/api/v1/admin/compliance/:providerId/review` | Record a capability verification decision (audited). |
| POST | `/api/v1/admin/compliance/:providerId/kill-switch` | Engage/release a kill switch (effective immediately, audited). |
| POST | `/api/v1/admin/providers/:providerId/enabled` | Enable/disable a provider. |
| GET | `/api/v1/admin/source-health` | Live latency percentiles, success rate, circuit state, rate-limit posture per provider. |
| GET | `/api/v1/admin/analytics` | Aggregate analytics (consented, session-scoped). |
| GET | `/api/v1/admin/audit` | The audit log. |
| GET | `/api/v1/admin/compliance-events` | Recorded capability refusals. |
| GET | `/api/v1/admin/debug/product/:providerId/:providerProductId` | The product debugger: raw provider payload beside the normalized view, match evidence, price derivation and the link result. |

## Streaming search

`GET /api/v1/search/stream` returns `text/event-stream`. Because it writes to the
raw socket (bypassing Fastify's reply decoration), it sets CORS headers itself
from `CORS_ALLOWED_ORIGINS`. A minimal consumer:

```js
const es = new EventSource(
  `${API}/api/v1/search/stream?q=${encodeURIComponent(q)}&source=all&country=IL&currency=ILS`,
  { withCredentials: true },
);
es.addEventListener('stage', (e) => { /* real stage transition */ });
es.addEventListener('provider', (e) => { /* per-provider RUNNING/OK/FAILED */ });
es.addEventListener('result', (e) => { /* ranked groups */ });
es.addEventListener('done', () => es.close());
```

Every event reflects work that actually happened; the client renders real
progress, never an animated guess.
