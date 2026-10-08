# Setup

## Prerequisites

- **Node.js 20.11.0 or newer.** The repository pins a version in `.nvmrc`;
  `nvm use` picks it up. The engine requirement is enforced in the root
  `package.json`.
- **PostgreSQL 16.** Any 16.x server reachable over TCP. No extensions beyond
  the stock distribution are required — the schema deliberately avoids
  `citext` and other add-ons so a plain server works.
- **(Optional) Redis**, only if you run more than one backend or worker
  instance. For single-process local development the in-memory cache and queue
  drivers are the default and need nothing.

## Install

```bash
git clone <this repository>
cd ali
cp .env.example .env
npm install
```

`npm install` installs every workspace in one pass (npm workspaces hoist to the
root `node_modules`). There is no per-workspace install step.

Open `.env` and set, at a minimum:

```ini
SESSION_SECRET=<32+ random bytes, base64>   # openssl rand -base64 48
DATABASE_URL=postgres://shelf:shelf@localhost:5432/shelf
```

Everything else has a working default for local development. Provider
credentials can stay empty — see [environment.md](environment.md) for the full
list and [the demo-fixtures note](#running-without-credentials) below for what
happens when they are.

## Database

Create the database and role, then run the migrations:

```bash
createdb shelf          # or: psql -c 'CREATE DATABASE shelf;'
npm run db:migrate      # applies every pending migration, in order
npm run db:status       # shows which migrations are applied
```

Migrations are forward-only and the runner records each applied migration, so
`db:migrate` is safe to re-run; it applies only what is pending. The schema is
never edited by hand — see [database.md](database.md).

### Running Postgres without Docker

If you cannot run the Docker Compose service (`npm run infra:up`), a plain
local server works. Initialise a data directory owned by an unprivileged user
and start it on a spare port:

```bash
initdb -D "$HOME/pgdata"
pg_ctl -D "$HOME/pgdata" -o "-p 5433 -k $HOME" -l "$HOME/pg.log" start
createdb -p 5433 -h 127.0.0.1 shelf
# then point DATABASE_URL at it:
export DATABASE_URL="postgres://$USER@127.0.0.1:5433/shelf"
```

## Running locally

```bash
npm run dev            # backend :4000, frontend :3000, workers — all together
```

`npm run dev` is a thin launcher (`scripts/dev.mjs`): it runs each workspace's
own `dev` script, prefixes their output per service, and tears the whole group
down on Ctrl-C so a half-stopped stack never keeps a port. Narrow the set with
arguments:

```bash
npm run dev -- backend frontend     # skip workers
```

Or run a single service directly:

```bash
npm run dev:backend    # tsx watch, :4000
npm run dev:frontend   # next dev, :3000
npm run dev:workers    # the background job loop
```

Then open <http://localhost:3000>. The API is at <http://localhost:4000>; a
quick health check:

```bash
curl http://localhost:4000/health     # {"status":"ok",...}
curl http://localhost:4000/ready      # 200 only once the database is reachable
```

## Running without credentials

With `ALLOW_DEMO_FIXTURES=true` (the default in `.env.example`) and no provider
credentials, search returns clearly-labelled demo data so the whole UI is
exercisable offline. Every fixture record carries `dataOrigin=DEMO_FIXTURE`,
every response that includes one is flagged, and the UI shows a persistent demo
banner. This is a development affordance, not a fallback: the backend **refuses
to start** if `ALLOW_DEMO_FIXTURES=true` while `NODE_ENV=production` (error
`ERROR_DEMO_FIXTURES_IN_PRODUCTION`).

To develop against a live provider, fill in that provider's block in `.env` and
set its `*_ENABLED=true`. A provider with missing credentials reports
`NOT_CONFIGURED` from `/api/v1/providers` and is excluded from search rather
than faked. See [providers.md](providers.md).

## Verifying your setup

```bash
npm run verify     # typecheck + unit tests + lint — the pre-commit gate
```

If `verify` is green, the checkout is sound. The end-to-end API tests
additionally need a database:

```bash
DATABASE_URL="postgres://shelf@127.0.0.1:5432/shelf" \
SESSION_SECRET=test-only-secret-at-least-32-characters-long-aaaa \
npm run test:e2e
```

Without `DATABASE_URL` the e2e suite skips cleanly rather than failing. See
[testing.md](testing.md).

## Common commands

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Backend + frontend + workers, together                    |
| `npm run build`      | Compile shared → integrations → backend (publishable JS)  |
| `npm run typecheck`  | `tsc -b` across every workspace, including the frontend    |
| `npm run test`       | Unit tests (`node:test`)                                   |
| `npm run test:e2e`   | In-process API tests (needs a database)                    |
| `npm run lint`       | House-rule linter (`scripts/lint.mjs`)                     |
| `npm run verify`     | typecheck + test + lint                                    |
| `npm run db:migrate` | Apply pending migrations                                   |
| `npm run db:status`  | Show migration state                                       |
| `npm run infra:up`   | `docker compose up -d` (Postgres, and Redis if enabled)    |
| `npm run infra:down` | Stop the compose services                                  |
