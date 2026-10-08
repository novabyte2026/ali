# Database

PostgreSQL 16. The schema is defined entirely by forward-only SQL migrations in
`database/migrations/`; it is never edited by hand and there is no ORM
generating it. A few principles hold across every table:

- **Money is integer minor units + a currency code.** There is no `NUMERIC`
  price column anywhere. A price that becomes a float is a cent off that nobody
  can later explain.
- **Observations are append-only.** `offers` is the latest view for serving;
  `price_observations` and `shipping_observations` are the history, and they are
  written only where the provider's `persistProviderData` capability permits it.
- **Provider permissions are data.** What we may do with a marketplace's data
  lives in `provider_policies`, versioned and audited — not in application code.
- **A guest owns no rows.** Everything personal hangs off a user via a foreign
  key, so the guest limitation is a data-model boundary, not a hidden button.

## The migration runner

```bash
npm run db:migrate    # apply all pending migrations, in id order
npm run db:status     # show each migration's state
```

(These proxy to `tsx database/src/cli.ts up|status`.) The runner:

- Reads `DATABASE_URL` from the environment only — never as a CLI argument, so a
  password cannot land in shell history or a process listing.
- Records each applied migration in a `schema_migrations` table with a SHA-256
  **checksum** of the file. Editing an already-applied migration is a hard error
  (`CHECKSUM_MISMATCH`) rather than a silent drift — you add a new migration
  instead.
- Takes a **session-level advisory lock** (`pg_advisory_lock`) so two instances
  deploying at once serialize instead of racing.
- Is idempotent: re-running `up` applies only what is pending.

## The migrations

| File | Adds |
| ---- | ---- |
| `0001_core_identity.sql` | Users, OAuth identities, sessions, consent. Session tokens are never stored — only a salted SHA-256 hash. Privacy preferences default to the minimum. |
| `0002_providers_and_policy.sql` | Providers, the **policy registry** (`provider_policies`), per-capability state, and kill switches. The legal spine: a unique index enforces one active policy per provider. |
| `0003_catalog.sql` | Product identity at three levels — `product_groups` (a product we believe exists), `product_sources` (one provider's listing), `product_matches` (the evidence linking a listing to a group). |
| `0004_pricing_and_offers.sql` | `offers` (latest), `price_observations` / `shipping_observations` (append-only history), `coupons`, `coupon_checks`, `exchange_rates`. |
| `0005_user_features.sql` | Favourites, watchlists, saved searches, alerts, carts, deal-radar subscriptions. All user-owned, all deleted with the user. |
| `0006_affiliate_and_analytics.sql` | Affiliate attribution, analytics events, provider health/call logs, job state — in **separate tables with separate retention** (see below). |
| `0007_seed_providers.sql` | Initial provider rows and their conservative starting policies. **Read its header before shipping** — the capability states are deliberate under-claims, not legal advice. |

## Table groups

**Identity & auth** — `users`, `user_identities`, `sessions`,
`oauth_transactions`, `user_consents`.

**Compliance** — `providers`, `provider_policies`, `provider_capabilities`,
`capability_kill_switches`, `compliance_events`, `audit_logs`.

**Catalog** — `product_groups`, `product_sources`, `product_matches`.

**Pricing** — `offers`, `price_observations`, `shipping_observations`,
`coupons`, `coupon_checks`, `exchange_rates`.

**User features** — `favorites`, `watchlist_entries`, `saved_searches`,
`alerts`, `alert_events`, `shopping_carts`, `cart_items`,
`deal_radar_subscriptions`, `deal_events`, `search_history`.

**Affiliate & analytics** — `affiliate_configurations`, `affiliate_clicks`,
`affiliate_conversions`, `analytics_events`, `search_telemetry`,
`provider_call_log`, `notification_outbox`.

**Jobs** — `job_locks`, `job_runs`.

## Data separation and retention

Affiliate attribution, product analytics and personal data live in different
tables on purpose. A click record (`affiliate_clicks`) carries a **rotating
session hash** and an optional user id; an analytics event
(`analytics_events`) carries the session hash only, unless the user consented
to user-scoped analytics. Neither stores an IP address or a user-agent string
in the clear. History and other personal rows are swept on a retention schedule
by the `retention-sweep` worker. See [security.md](security.md) and
[monitoring.md](monitoring.md).

## Adding a migration

1. Create the next-numbered file, e.g. `0008_<topic>.sql`. Write a header that
   explains *why*, for the reviewer.
2. Use only plain SQL that a stock Postgres 16 accepts (no non-default
   extensions — the schema avoids `citext` for exactly this reason, using `TEXT`
   with a generated lowercased column where case-insensitivity is needed).
3. Never edit an applied migration; the checksum guard will reject it. Fix
   forward with a new file.
4. `npm run db:migrate` then `npm run db:status` to confirm.
