# Architecture

Shelf is a monorepo of six TypeScript workspaces with a strict dependency
direction. Nothing lower in the list may import something higher:

```
shared  ─→  integrations  ─→  backend  ─→  workers
   │                             │
   └──────────────→ frontend ────┘   (frontend consumes backend over HTTP only)
database ─→ (its runner is used by backend and workers at the edges)
```

`shared/` depends on nothing. That is deliberate: the honesty primitives have to
be the foundation, usable from any layer without dragging in a database or an
HTTP client.

## The honesty primitives

These three types are the reason the product can make its promises. They live in
`shared/` and everything is built on them.

### `Datum<T>` — a value that knows how sure it is

Every externally-sourced fact — a price, a shipping cost, a rating — is a
`Datum<T>`, never a bare `T`. It is a tagged union of four states:

| State        | Meaning | How it renders |
| ------------ | ------- | -------------- |
| `KNOWN`      | A value from a source, with provenance (which provider, observed when). | The figure, plainly. |
| `ESTIMATED`  | A derived value with a stated basis and a range. | "~₪40–₪55 (estimated)". |
| `UNKNOWN`    | Not provided by the source, or not computable, with a reason. | "not available" — **never** a zero or a dash that looks like data. |
| `RESTRICTED` | The provider's policy does not permit us this field. | "not available for this source". |

Combining data propagates the *weakest* state: `weakestState` means a total
built from a known price and an unknown shipping cost is itself not fully known,
and cannot present as exact. This is why a total cost never silently becomes a
confident number when one of its parts is missing — the type won't let it.

### Money — integer minor units, never a float

There is no floating-point price anywhere, and no `NUMERIC` price column in the
database. Money is an integer count of minor units plus a currency code with a
per-currency exponent. `moneyFromDecimal` rounds half-up while guarding against
binary-float error; `add`/`subtract` throw on a currency mismatch rather than
silently combining ILS and USD. Conversion goes through a dated FX rate and the
converted figure carries the rate's as-of date.

### Capabilities — what a provider is allowed to do

Twenty-two capabilities (`search`, `currentPrice`, `priceHistory`,
`priceAlerts`, `coupons`, `reviewContent`, `persistProviderData`,
`crossProviderComparison`, …), each in one of five states:

| State                   | Meaning | The fix is |
| ----------------------- | ------- | ---------- |
| `AVAILABLE`             | Permitted and configured; use it. | — |
| `NOT_PERMITTED`         | The programme's terms forbid it. | A legal/terms review — **not** a deployment change. |
| `VERIFICATION_REQUIRED` | We have not confirmed it is permitted. | Confirm against the programme, then update the policy. |
| `NOT_CONFIGURED`        | Permitted, but credentials are missing. | Add the credentials. |
| `DISABLED_BY_OPERATOR`  | A kill switch is engaged. | Re-enable it, deliberately. |

The distinction between `NOT_PERMITTED` and `NOT_CONFIGURED` is load-bearing and
tested: reporting a forbidden capability as merely unconfigured would suggest the
fix is to add credentials rather than to not do it at all.

## Product identity

The most consequential decision the system makes is whether two listings are the
same product. The match level taxonomy, from strongest to weakest:

- `EXACT_MATCH` — same manufacturer product and variant, identifier-backed.
- `LIKELY_SAME_MODEL` — same model, variant not fully determined.
- `VARIANT_MATCH` — same model, **explicitly different** variant (64GB vs 128GB).
- `STRONG_SIMILARITY` — same category, close spec, different product.
- `ALTERNATIVE` — a reasonable alternative for the stated need.
- `WEAK_SIMILARITY` — same category only.
- `UNKNOWN` — not enough information to place it.

Only `EXACT_MATCH` and `LIKELY_SAME_MODEL` are allowed to say "the same product"
and are eligible for a single-product cross-source price comparison. Heuristic
similarity (title, spec, category) is **capped below the identity threshold** —
the cap is `HEURISTIC_ONLY_CEILING = 0.55`, under the `0.6` identity line — so
title similarity can never on its own produce a same-product claim. A unit test
pins this invariant. A `VARIANT_MATCH` is deliberately excluded from
single-product price rows, because comparing the price of a 64GB phone against a
128GB one as if they were one product is exactly the dishonesty the rule exists
to prevent.

## A search, end to end

`GET /api/v1/search/stream` runs the pipeline and emits a Server-Sent Event at
every real stage transition. There is no synthetic progress bar; each event
reflects work that actually happened.

1. **PARSING** — The natural-language query is parsed (Hebrew or English) into a
   `QueryIntent`: keywords, budget ceiling (and whether it is a hard limit),
   rating floor, brand, variant hints, requested sources. Recognized tokens are
   returned so the user can remove any one of them.
2. **SELECTING_SOURCES** — The requested providers are intersected with those
   actually available. The compliance guard resolves each provider's capability
   matrix from the policy registry; a provider whose `search` capability is not
   `AVAILABLE` is dropped here with a reason, not silently.
3. **QUERYING_SOURCES** — Available providers are queried concurrently, each
   behind a per-provider timeout, rate limiter and circuit breaker. A provider
   that fails, times out or is rate-limited degrades the result to the sources
   that answered; it never fails the whole search. Per-provider state
   (`RUNNING`, `OK`, `EMPTY`, `FAILED`, `CIRCUIT_OPEN`) streams out as it
   happens.
4. **NORMALIZING** — Each provider's raw payload is mapped into the normalized
   model. Mapping checks the capability first (a forbidden field becomes
   `RESTRICTED`), then absence (`UNKNOWN`), then a `KNOWN` value with provenance.
   The raw payload is retained for the admin product debugger.
5. **MATCHING** — Listings are grouped by product identity using the taxonomy
   above. A single-source group is only badged `EXACT_MATCH` when it carries its
   own identifiers; otherwise it is `UNKNOWN`, because a listing compared only
   against itself has proven nothing.
6. **PRICING** — Total cost is assembled per offer: item + shipping + tax +
   discount + coupon, with `Datum` state propagation. A missing material
   component keeps the total `UNKNOWN`; an estimated one produces a labelled
   range. Only `VERIFIED` coupons are deducted.
7. **RANKING** — Hard filters first (a stated budget ceiling removes everything
   above it unless the user opts in to see over-budget), then scoring by intent
   match, budget proximity, match quality, source reliability and freshness. A
   near-budget genuine match outranks a far-cheaper loose one. **Commission is
   not read anywhere in this module.**

The non-streaming `GET /api/v1/search` runs the same pipeline and returns the
final result in one response.

## Backend composition

The backend is a Fastify application assembled from an `AppContext` — the
database pool, the provider registry, the compliance guard factory, the
converter, the logger and the stores. `backend/src/index.ts` exports these as a
library with no side effects, so the workers and the test suite can build a
context and call the same code paths without starting an HTTP listener.
`backend/src/server.ts` is the thin entry point that does start one.

Routes live under `backend/src/routes/` and are registered against the app. Every
non-public route runs `requireUser` and a `requirePermission(...)` preHandler, so
authorization is enforced by the server, not by the frontend hiding a button.

### The compliance guard

A single oracle answers "may we do X with provider P right now?". It reads the
active policy version from the registry, narrows the declared capability matrix
by the provider's enabled flag, engaged kill switches and credential
configuration (most-restrictive-wins), and returns the resolved state. Every
read that touches provider data passes through it; a refusal is recorded as a
compliance event and surfaces to the UI as `RESTRICTED`. See
[compliance.md](compliance.md).

## Frontend

Next.js 15 App Router. No UI component library and no utility-CSS framework:
styling is CSS Modules over a design-token layer, using logical properties
(`margin-inline-start`, not `margin-left`) so Hebrew RTL and English LTR share
one stylesheet. The frontend talks to the backend over HTTP only; it holds no
database credentials and no provider secrets. It mirrors the honesty rules on the
display side — a `describeMoney`/`describeTotal` layer means the UI cannot print
a figure without its provenance, and an unknown value is words, never a bare dash
that could be mistaken for data.

## Workers

A single long-running process runs scheduled jobs under Postgres advisory locks
(`job_locks`), so running two worker instances does not double-execute a job.
The jobs: coupon re-checking, compliance monitoring, affiliate-link health,
notification dispatch and retention sweeps. See [monitoring.md](monitoring.md).
