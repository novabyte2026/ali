# Environment variables

Every variable is listed in `.env.example`. Copy it to `.env` and fill in what
you need. The guiding rule: **a missing value degrades honestly.** An unset
provider credential makes that provider report `NOT_CONFIGURED` and drop out of
search; it never causes a fabricated result or a silent default that pretends
to be real.

Only the `NEXT_PUBLIC_*` keys are shipped to the browser. Nothing else in `.env`
is ever exposed to the frontend bundle. Never commit `.env`; it is in
`.gitignore`.

## Core

| Variable    | Default       | Notes |
| ----------- | ------------- | ----- |
| `NODE_ENV`  | `development` | `production` tightens boot checks (see `ALLOW_DEMO_FIXTURES`) and expects secure cookies. |
| `LOG_LEVEL` | `info`        | `debug`, `info`, `warn`, `error`. Logs are structured JSON. |

## Backend

| Variable               | Default                 | Notes |
| ---------------------- | ----------------------- | ----- |
| `BACKEND_PORT`         | `4000`                  | HTTP listen port. |
| `BACKEND_HOST`         | `0.0.0.0`               | Listen address. |
| `PUBLIC_API_URL`       | `http://localhost:4000` | The API's own public URL (used in OAuth redirects and links). |
| `PUBLIC_WEB_URL`       | `http://localhost:3000` | The frontend's public URL. |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated list of origins allowed to call the API with credentials. The streaming search endpoint sets its CORS headers from this list too. |

## Database

| Variable            | Default                                      | Notes |
| ------------------- | -------------------------------------------- | ----- |
| `DATABASE_URL`      | `postgres://shelf:shelf@localhost:5432/shelf` | Standard libpq URL. **Required** for anything beyond `/health`. |
| `DATABASE_POOL_MAX` | `10`                                         | Max pool connections. |
| `DATABASE_SSL`      | `false`                                      | Set `true` for managed Postgres that requires TLS. |

## Cache and queue

| Variable       | Default                  | Notes |
| -------------- | ------------------------ | ----- |
| `CACHE_DRIVER` | `memory`                 | `memory` or `redis`. `memory` is single-process only. |
| `QUEUE_DRIVER` | `memory`                 | `memory` or `redis`. Use `redis` for any multi-instance deployment. |
| `REDIS_URL`    | `redis://localhost:6379` | Used when either driver is `redis`. |

Per-provider cache TTLs are **not** set here — they are capped by each
provider's policy `maxCacheSeconds` in the database, so an operator can never
accidentally cache longer than a programme permits.

## Sessions and crypto

| Variable               | Default         | Notes |
| ---------------------- | --------------- | ----- |
| `SESSION_SECRET`       | *(empty)*       | **Required.** 32+ random bytes, base64. `openssl rand -base64 48`. The backend refuses to boot without it. |
| `SESSION_COOKIE_NAME`  | `shelf_session` | Cookie name. |
| `SESSION_TTL_HOURS`    | `720`           | Session lifetime (30 days). |
| `SESSION_COOKIE_SECURE`| `false`         | Keep `false` only for local http. **Set `true` in production.** |

Session tokens are opaque and rotating; only a salted SHA-256 hash is stored, so
a database leak does not hand over live sessions. See [security.md](security.md).

## Google OAuth (sign in)

| Variable               | Default                                             | Notes |
| ---------------------- | --------------------------------------------------- | ----- |
| `GOOGLE_CLIENT_ID`     | *(empty)*                                           | Without it, sign-in is unavailable and the UI says so. |
| `GOOGLE_CLIENT_SECRET` | *(empty)*                                           | |
| `GOOGLE_REDIRECT_URI`  | `http://localhost:4000/api/v1/auth/google/callback` | Must match the authorized redirect in the Google console. |

The flow is authorization-code with PKCE and state binding. Guests can search
without an account; an account unlocks favourites, saved searches, alerts,
carts and history.

## Admin bootstrap

| Variable       | Default   | Notes |
| -------------- | --------- | ----- |
| `ADMIN_EMAILS` | *(empty)* | Comma-separated e-mails promoted to the `admin` role on first sign-in. Everything admin-only is gated on this role server-side. |

## Provider credentials

Each provider block is optional and independent. A provider with missing
credentials is `NOT_CONFIGURED` and excluded from search. Full details, marketplace
host/region tables and signing notes are in [providers.md](providers.md).

### Amazon (Product Advertising API 5.0 + Associates)

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `AMAZON_ENABLED` | `false` | Master switch for the adapter. |
| `AMAZON_ACCESS_KEY` / `AMAZON_SECRET_KEY` | *(empty)* | PA-API keys from an approved Associates account. |
| `AMAZON_PARTNER_TAG` | *(empty)* | Associates tracking id (e.g. `mytag-20`), per marketplace. |
| `AMAZON_HOST` | `webservices.amazon.com` | Marketplace-specific; see the table in providers.md. |
| `AMAZON_REGION` | `us-east-1` | Marketplace-specific. |
| `AMAZON_MARKETPLACE` | `www.amazon.com` | Marketplace-specific. |
| `AMAZON_DEFAULT_COUNTRY` | `US` | |
| `AMAZON_RATE_LIMIT_RPS` / `AMAZON_RATE_LIMIT_BURST` | `1` / `1` | PA-API quota is low until revenue grows; keep conservative. |

### AliExpress (Open Platform affiliate APIs)

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `ALIEXPRESS_ENABLED` | `false` | |
| `ALIEXPRESS_APP_KEY` / `ALIEXPRESS_APP_SECRET` | *(empty)* | Open Platform app credentials. |
| `ALIEXPRESS_GATEWAY` | `https://api-sg.aliexpress.com/sync` | TOP gateway. |
| `ALIEXPRESS_TRACKING_ID` | *(empty)* | Affiliate tracking id from the affiliate console. |
| `ALIEXPRESS_DEFAULT_COUNTRY` | `IL` | |
| `ALIEXPRESS_RATE_LIMIT_RPS` / `ALIEXPRESS_RATE_LIMIT_BURST` | `5` / `10` | |

### Temu (affiliate / partner programme)

Temu's partner API surface is granted per account. Leave the base URL and
credentials empty until your own programme contract confirms the endpoints and
the operations you are licensed to call; the adapter then reports
`VERIFICATION_REQUIRED` for every capability rather than guessing.

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `TEMU_ENABLED` | `false` | |
| `TEMU_API_BASE_URL` | *(empty)* | Supplied by your programme contract. |
| `TEMU_APP_KEY` / `TEMU_APP_SECRET` | *(empty)* | |
| `TEMU_AFFILIATE_ID` | *(empty)* | |
| `TEMU_DEFAULT_COUNTRY` | `IL` | |
| `TEMU_RATE_LIMIT_RPS` / `TEMU_RATE_LIMIT_BURST` | `2` / `4` | |

## Currency rates

| Variable            | Default   | Notes |
| ------------------- | --------- | ----- |
| `FX_DRIVER`         | `static`  | `static` uses `config/fx-rates.json` and labels every converted figure with the file's as-of date. `http` fetches live rates. No driver ever invents a rate. |
| `FX_HTTP_URL`       | *(empty)* | Rate feed URL when `FX_DRIVER=http`. |
| `FX_HTTP_API_KEY`   | *(empty)* | |
| `FX_REFRESH_MINUTES`| `720`     | How often to refresh (12h). |

The static table ships with the repository for development and **must** be
replaced by an `http` feed for production, or converted prices stay dated to the
file. The feature-status register marks currency conversion `PARTIAL` for this
reason.

## Mail (alerts)

| Variable      | Default                          | Notes |
| ------------- | -------------------------------- | ----- |
| `MAIL_DRIVER` | `console`                        | `console` prints to the log (dev only); `smtp` sends real mail. |
| `SMTP_URL`    | *(empty)*                        | Required for `smtp`. |
| `MAIL_FROM`   | `Shelf <no-reply@example.com>`   | From header. |

With `MAIL_DRIVER=console`, in-app alert delivery still works immediately; only
e-mail is stubbed. The alerts feature is marked `PARTIAL` until SMTP is set.

## Demo fixtures

| Variable              | Default | Notes |
| --------------------- | ------- | ----- |
| `ALLOW_DEMO_FIXTURES` | `true`  | Serves labelled demo data for providers without credentials. **Must be `false` in production — the backend refuses to boot otherwise.** |

## Frontend (public — shipped to the browser)

| Variable                      | Default                 | Notes |
| ----------------------------- | ----------------------- | ----- |
| `NEXT_PUBLIC_API_URL`         | `http://localhost:4000` | Where the browser calls the API. |
| `NEXT_PUBLIC_SITE_NAME`       | `Shelf`                 | |
| `NEXT_PUBLIC_DEFAULT_LOCALE`  | `he`                    | `he` or `en`. The product is RTL-first. |
| `NEXT_PUBLIC_DEFAULT_COUNTRY` | `IL`                    | Default destination country. |
| `NEXT_PUBLIC_DEFAULT_CURRENCY`| `ILS`                   | Default display currency. |

## Boot-time validation

The backend validates configuration on startup and fails fast with a clear
message rather than booting half-configured. The checks that will stop a boot:

- `SESSION_SECRET` missing or too short.
- `ALLOW_DEMO_FIXTURES=true` with `NODE_ENV=production`.
- A provider with `*_ENABLED=true` but incomplete credentials (it is reported,
  not silently disabled).
