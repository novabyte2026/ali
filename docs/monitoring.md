# Monitoring and operations

## Health and readiness

| Endpoint | Meaning | Use for |
| -------- | ------- | ------- |
| `GET /health` | Liveness. `200` whenever the process is running. | Restart policy. |
| `GET /ready` | Readiness. `200` only when the database is reachable. | Gating traffic during a rollout. |
| `GET /api/v1/meta/metrics` | Lightweight operational counters (request counts, source outcomes). | Scraping into your metrics system. |

## Logs

Logs are structured JSON, one object per line, at the level set by `LOG_LEVEL`.
Every request log carries a `requestId` that matches the `requestId` in any error
response, so a user-reported error ("request id req_…") maps straight to the
server-side line. A typical pair:

```json
{"level":"info","msg":"request","requestId":"req_3cc6…","method":"GET","route":"/api/v1/search","status":200,"durationMs":33,"role":"guest"}
{"level":"warn","msg":"request failed","requestId":"req_6ca1…","code":"ERROR_AUTH_REQUIRED","route":"/api/v1/me/profile"}
```

Logs never contain a session token, a provider secret, an IP address or a
user-agent string in the clear. Error logs carry the stable `code`, not a raw
message leaked to the client.

## Source health

`GET /api/v1/admin/source-health` (admin) reports, per provider, live:

- latency percentiles,
- success rate,
- circuit-breaker state (closed / open / half-open),
- rate-limit posture.

This is backed by `provider_call_log`. When a provider's circuit is open, search
reports it as `CIRCUIT_OPEN` and degrades to the sources that answered — the
source-health page is where an operator sees that happening and why.

## Compliance monitoring

`GET /api/v1/admin/compliance` and `/api/v1/admin/compliance-events` (admin) show
the capability-verification backlog, policy versions, kill-switch states and the
log of capability refusals. The `compliance-monitor` worker watches these for
anomalies. A rising refusal count for a capability means a feature is asking for
something the current policy forbids — worth an operator's attention.

## The worker loop

The workers process runs a simple interval scheduler. Each job holds a
database-backed advisory lock while it runs, so with multiple worker instances a
given job still runs on only one at a time, and a job that overruns its interval
does not overlap itself. Each run is recorded in `job_runs`.

| Job | Interval | First run after start | Does |
| --- | -------- | --------------------- | ---- |
| `notification-dispatcher` | 1 min | 15 s | Delivers queued alert notifications from `notification_outbox` (in-app immediately; e-mail when SMTP is configured). |
| `coupon-checker` | 30 min | 90 s | Re-checks coupon status and decays stale `VERIFIED` codes to weaker states as their freshness window lapses. |
| `affiliate-link-monitor` | 1 h | 3 min | Validates stored affiliate links against the current host allowlist and policy. |
| `retention-sweep` | 1 h | 30 s | Deletes data past its retention window (history, stale observations, expired sessions/transactions). |
| `compliance-monitor` | 6 h | 2 min | Scans for policy/capability anomalies and records compliance events. |

The worker binds **no HTTP port** — a worker that accidentally served HTTP would
be a surprising attack surface. It refuses to start if the database is
unreachable, and shuts its jobs and pool down cleanly on `SIGTERM`/`SIGINT`.

## What "healthy" looks like

- `/ready` returns `200`.
- Source-health success rates are high and no circuit is stuck open.
- `job_runs` shows every job completing on schedule; none perpetually failing.
- The compliance refusal count is flat, not climbing.
- No error log line carries `ERROR_INTERNAL` at any volume — those are bugs, not
  expected conditions. (Typed errors like `ERROR_SOURCE_TIMEOUT` are normal.)
