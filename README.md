# Shelf — Shopping Intelligence Platform

Shelf is a search and price-comparison engine over authorized marketplace
affiliate programmes (Amazon, AliExpress, Temu, and a unified "All" mode). It
answers one question honestly: *where is this product cheaper, really?* — and
refuses to answer when it cannot.

The product is built around four non-negotiable commitments. They are not
features; they are the reason the rest of the code is shaped the way it is.

1. **It never fabricates.** An unknown price, shipping cost, tax, rating or
   review count is shown as *not available* / *not verified* / an *estimated
   range* — never as zero and never as a confident number. This is enforced in
   the type system (`Datum<T>`), not by convention.
2. **"Same product" is a claim it has to earn.** Two listings are called the
   same product only on identifier evidence (a checksum-valid GTIN, an agreeing
   MPN). Everything else is a *similar product*. Heuristic title/spec similarity
   is capped below the identity threshold so it can never assert sameness on its
   own.
3. **A stated budget is a hard wall.** "up to ₪120" removes everything above
   ₪120 from the results, and a ₪110 genuine match outranks a ₪12 loose one.
   The budget is a filter, not a hint.
4. **Commission never touches ranking.** There is no code path in the ranking
   module that reads a commission figure, and a test asserts the word does not
   appear in it. Affiliate disclosure is always visible; there is no cloaking
   and no dark patterns.

What a provider is *allowed* to do differs per provider and is **data, not
code**: a versioned, operator-editable, audited policy registry in the database
decides every capability. Nothing about a marketplace's terms is hardcoded in a
feature.

Honesty extends to the product's own maturity. Every feature declares its real
state — `PRODUCTION_READY`, `PARTIAL`, `INTEGRATION_PENDING` or `PLANNED` — in a
register served at `/api/v1/meta/features` and shown in the admin console. See
[docs/feature-status.md](docs/feature-status.md). Nothing in the UI pretends to
be wired to a live source when it is not.

## Layout

A TypeScript monorepo (npm workspaces), strict mode throughout:

| Workspace          | What it is                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| `shared/`          | The honesty primitives: `Datum<T>`, money (integer minor units), the capability model, error codes, the feature-status register, shared types. Depends on nothing. |
| `database/`        | Forward-only SQL migrations and the migration runner. Schema never changes by hand. |
| `integrations/`    | Provider adapters (Amazon PA-API, AliExpress, Temu), request signing, response mapping, affiliate-link construction, demo fixtures. |
| `backend/`         | Fastify API: streaming search, matching, pricing, coupons, deals, auth + RBAC, the compliance guard, admin. |
| `workers/`         | Background jobs: coupon checking, compliance monitoring, affiliate-link health, notification dispatch, retention sweeps. |
| `frontend/`        | Next.js 15 App Router, CSS Modules + design tokens (no UI framework), Hebrew/English, RTL-first. |

## Quick start

```bash
# 1. Node 20.11+ and PostgreSQL 16.
cp .env.example .env            # then fill in SESSION_SECRET at minimum
npm install

# 2. Create the schema.
npm run db:migrate

# 3. Run everything (backend :4000, frontend :3000, workers).
npm run dev
```

With no provider credentials the platform runs on clearly-labelled demo
fixtures (`ALLOW_DEMO_FIXTURES=true`): every record carries
`dataOrigin=DEMO_FIXTURE`, the UI shows a persistent demo banner, and the
backend **refuses to boot with fixtures enabled when `NODE_ENV=production`**.

Full setup — including running Postgres without Docker — is in
[docs/setup.md](docs/setup.md).

## Verifying

```bash
npm run verify     # typecheck (all workspaces) + unit tests + house-rule lint
npm run test       # unit tests only (node:test, no runner dependency)
npm run test:e2e   # in-process API tests; requires DATABASE_URL
```

The suite pins the four commitments above directly: the heuristic-match cap, the
budget rule, the commission-absence check, the total-cost state propagation, and
server-side guest authorization are all covered. See
[docs/testing.md](docs/testing.md).

## Documentation

| Document | Covers |
| -------- | ------ |
| [setup.md](docs/setup.md)               | Prerequisites, install, database, running locally |
| [environment.md](docs/environment.md)   | Every environment variable and what happens when it is unset |
| [architecture.md](docs/architecture.md) | How a search flows through the system; the honesty primitives |
| [database.md](docs/database.md)         | Schema, the seven migrations, the migration runner |
| [api.md](docs/api.md)                   | Every endpoint, the error envelope, streaming |
| [providers.md](docs/providers.md)       | The adapter contract, per-provider configuration and marketplaces |
| [affiliate.md](docs/affiliate.md)       | Tracking-id configuration, link construction, disclosure, click tracking |
| [compliance.md](docs/compliance.md)     | The capability model, the policy registry, kill switches, the release gate |
| [deployment.md](docs/deployment.md)     | Building, process model, Redis, production checklist |
| [monitoring.md](docs/monitoring.md)     | Health/readiness, metrics, source health, logs, the worker loop |
| [testing.md](docs/testing.md)           | What is tested and why, how to run it |
| [security.md](docs/security.md)         | Sessions, RBAC, privacy defaults, data separation, secret handling |
| [feature-status.md](docs/feature-status.md) | The production-readiness register, in prose |

## License and scope

This is affiliate-comparison software. It links out to each marketplace; it is
**not** a checkout and never takes payment. Operating it requires your own
approved affiliate programme accounts and a review of each programme's current
terms against the capability defaults — see
[docs/compliance.md](docs/compliance.md#the-release-gate).
