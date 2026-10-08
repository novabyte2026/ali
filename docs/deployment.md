# Deployment

Shelf deploys as three independent processes against one PostgreSQL database:

- **backend** — the Fastify API (`@shelf/backend`, entry `dist/server.js`).
- **frontend** — the Next.js app (`@shelf/frontend`, `next start`).
- **workers** — the background job loop (`@shelf/workers`, `dist/index.js`).

They share one config definition and one database. The backend and workers are
stateless beyond the database and (optionally) Redis, so each scales
horizontally. The workers coordinate through Postgres advisory locks, so running
more than one worker instance does not double-execute a job.

## Build

```bash
npm ci
npm run build                              # shared → integrations → backend (JS + types)
npm run build --workspace @shelf/workers   # compiles against the built backend
npm run build --workspace @shelf/frontend  # next build
```

`npm run build` compiles the server-side publishable workspaces in dependency
order. The frontend and workers build against those outputs.

## Run

```bash
# backend
node backend/dist/server.js
# workers
node workers/dist/index.js
# frontend
npm run start --workspace @shelf/frontend   # next start --port 3000
```

Run each under a process supervisor (systemd, a container orchestrator, a PaaS)
that restarts on exit. `scripts/dev.mjs` is a development launcher only — it is
not a supervisor and must not run production.

## Database migrations

Run migrations as a deploy step, before starting the new backend:

```bash
npm run db:migrate
```

The runner takes a Postgres advisory lock, so two instances deploying at once
serialize rather than racing. It is idempotent and applies only what is pending.
Never edit an applied migration — the checksum guard rejects it; fix forward
with a new file.

## Redis for multi-instance

The in-memory cache and queue drivers are single-process. For more than one
backend or worker instance, switch both to Redis:

```ini
CACHE_DRIVER=redis
QUEUE_DRIVER=redis
REDIS_URL=redis://<host>:6379
```

With the memory drivers, two backends would each keep their own cache and the
queue would not be shared — correct for one process, wrong for several.

## Production configuration checklist

Before serving real traffic, confirm:

- [ ] `NODE_ENV=production`.
- [ ] `ALLOW_DEMO_FIXTURES=false`. (The backend refuses to boot otherwise — this
      is the hard stop against shipping fixtures.)
- [ ] `SESSION_SECRET` is a unique 32+ byte random value, not the dev value.
- [ ] `SESSION_COOKIE_SECURE=true` and the site is served over HTTPS.
- [ ] `CORS_ALLOWED_ORIGINS` lists only your real frontend origin(s).
- [ ] `DATABASE_SSL=true` if your Postgres requires it; `DATABASE_POOL_MAX`
      sized to the instance count × pool against the server's connection limit.
- [ ] `CACHE_DRIVER=redis` and `QUEUE_DRIVER=redis` if running more than one
      instance.
- [ ] `FX_DRIVER=http` with a real rate feed (the static table is dev-only).
- [ ] `MAIL_DRIVER=smtp` with `SMTP_URL` for real alert delivery.
- [ ] Google OAuth credentials set and `GOOGLE_REDIRECT_URI` registered in the
      Google console, matching `PUBLIC_API_URL`.
- [ ] `ADMIN_EMAILS` set to your operators.
- [ ] **The compliance release gate is done**: each provider's capabilities have
      been reviewed against its current programme terms and recorded. See
      [compliance.md](compliance.md#the-release-gate).

## Health checks

Point the load balancer / orchestrator at:

- `GET /health` — liveness; `200` whenever the process is up.
- `GET /ready` — readiness; `200` only when the database is reachable. Use this
  to gate traffic during a rollout.

See [monitoring.md](monitoring.md).

## Zero-downtime rollout sketch

1. `npm run db:migrate` (forward-compatible; the current backend keeps running).
2. Roll the backend instances, gated on `/ready`.
3. Roll the frontend.
4. Restart the workers last (they are safe to stop briefly; jobs resume on the
   next interval and locks prevent double execution).
