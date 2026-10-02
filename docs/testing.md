# Testing

Tests use the built-in `node:test` runner with `tsx` — no Jest, no Vitest, no
extra runner dependency. The suite is not about line coverage for its own sake;
it exists to **pin the product's promises**, so that a future change that
quietly breaks one of them fails loudly.

## Running

```bash
npm run test       # unit tests
npm run test:e2e   # in-process API tests (needs DATABASE_URL)
npm run test:all   # both
npm run verify     # typecheck + unit tests + lint — the pre-commit gate
```

The e2e suite skips cleanly (rather than failing) when `DATABASE_URL` is not
set, so `npm run test` is runnable with no infrastructure, while the e2e layer is
enforced wherever a database is present:

```bash
DATABASE_URL="postgres://shelf@127.0.0.1:5432/shelf" \
SESSION_SECRET=test-only-secret-at-least-32-characters-long-aaaa \
ALLOW_DEMO_FIXTURES=true \
npm run test:e2e
```

## Unit tests (`tests/unit/`)

Each file pins one load-bearing invariant. The ones that guard the product's
four commitments are called out.

| File | Pins |
| ---- | ---- |
| `money.test.ts` | Integer minor units; half-up rounding guarded against float error; `add`/`subtract` throw on currency mismatch; formatting never rounds to a whole number. |
| `matching.test.ts` | **"Same product" is earned.** Heuristic title/spec similarity is capped below the identity threshold, so it can never assert sameness alone; a variant conflict (64GB vs 128GB) demotes the match. |
| `ranking.test.ts` | **The budget rule and the commission rule.** A near-budget match outranks a far-cheaper loose one; a hard ceiling excludes over-budget results; and a source-level check asserts the ranking module contains no commission input at all. |
| `totals.test.ts` | **No fabrication in a total.** A total is `KNOWN` only if every component is known; a missing material component keeps it `UNKNOWN` (never zero); an estimated component yields a labelled range. |
| `parser.test.ts` | Hebrew/English budget, range, rating, brand and variant extraction; the recognized tokens are returned so the user can remove any one. |
| `capabilities.test.ts` | The narrowing order: `NOT_PERMITTED` wins over missing credentials; a disabled provider disables everything; a kill switch overrides; a feature needs every required capability `AVAILABLE`. |
| `coupons.test.ts` | Only a freshly `VERIFIED` coupon is deducted from a total; a decayed or possibly-active one is shown but not counted; eligibility (country, audience) gates application. |
| `affiliate-links.test.ts` | The destination is never cloaked; a non-allowlisted host is blocked (not redirected); a lookalike host is rejected; a missing tracking id yields an honest untracked link. |
| `amazon-signer.test.ts` | AWS SigV4 signing against the published test vectors. |
| `aliexpress-signer.test.ts` | Alibaba TOP signing. |

Run it and you should see every test pass:

```
# tests 68
# pass 68
# fail 0
```

## End-to-end tests (`tests/e2e/`)

`authorization.test.ts` builds the real Fastify app in-process and calls it with
Fastify's `inject` — the same code path a hand-forged request from DevTools would
hit — to prove **server-side** authorization, not merely a hidden button:

- Every `/me/*` user route returns `401 ERROR_AUTH_REQUIRED` with no cookie.
- Every `/admin/*` route returns `401` to a guest.
- `GET /api/v1/auth/me` describes a guest as a guest (`200`, `role: "guest"`),
  rather than erroring.
- Public search is not `401` for a guest.
- An error response leaks no stack frame, no `node_modules` path and no raw
  exception — its `error` object's keys are exactly `code`, `details`,
  `messageKey`, `requestId`, `retryable`.
- An empty query is rejected with `400 ERROR_QUERY_TOO_SHORT`.

## Manual / visual verification

The design is verified in a browser with Playwright (kept in the scratchpad, not
a project dependency): all pages render clean with no console errors, `dir="rtl"`
and `lang="he"` apply for Hebrew, no emoji appear in the rendered HTML, and the
comparison view declines to name a cheapest when totals are not comparable.

## Adding a test

Pin a behaviour, not an implementation detail. The good tests here each describe
a promise a user relies on ("a near-budget match outranks a far-cheaper loose
one") and would fail if that promise broke, regardless of how the code is
refactored. Prefer that over asserting the shape of an intermediate value.
