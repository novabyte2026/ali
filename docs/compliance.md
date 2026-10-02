# Compliance

The single most important architectural decision in Shelf: **no provider
permission is expressed in application code.** What the product may do with a
marketplace's data is data — versioned, operator-editable and audited — resolved
at runtime. A feature never contains a line like "Amazon doesn't allow price
history". It asks the compliance guard, and the guard reads the policy.

This exists so that a change in what a programme permits is an operator action
against a record with an audit trail, not a code change and a deploy; and so
that a reviewer can see, in one place, exactly what the system believes it is
allowed to do.

## The capability model

Twenty-two capabilities describe everything a provider might offer: `search`,
`productDetails`, `urlLookup`, `productImages`, `productContent`,
`productIdentifiers`, `ratings`, `reviewCounts`, `reviewContent`,
`currentPrice`, `referencePrice`, `shipping`, `priceHistory`, `priceAlerts`,
`coupons`, `deals`, `availability`, `sellerInfo`, `affiliateLinks`,
`brandAssets`, `persistProviderData`, `crossProviderComparison`.

Each is in exactly one of five states:

| State | Meaning | The fix |
| ----- | ------- | ------- |
| `AVAILABLE` | Permitted and configured. Use it. | — |
| `NOT_PERMITTED` | The programme's terms forbid it. | A terms/legal review. **Not** a deployment change. |
| `VERIFICATION_REQUIRED` | Not yet confirmed permitted. | Confirm against the programme, then record the decision. |
| `NOT_CONFIGURED` | Permitted, but credentials/endpoints are missing. | Add configuration. |
| `DISABLED_BY_OPERATOR` | A kill switch is engaged. | Release it, deliberately. |

Only `AVAILABLE` permits use. The difference between `NOT_PERMITTED` and
`NOT_CONFIGURED` is load-bearing and unit-tested: if a forbidden capability were
reported as merely unconfigured, it would imply the fix is to add credentials
rather than to not do it — exactly the wrong signal.

## Resolution: most-restrictive-wins

The guard computes a provider's effective capability matrix by **narrowing**
(`narrowMatrix`), taking the most restrictive of several inputs:

1. If the provider is disabled → every capability is `DISABLED_BY_OPERATOR`.
2. Else, for each capability, start from the **declared policy state**.
3. If a **kill switch** is engaged for it → `DISABLED_BY_OPERATOR`.
4. If the policy permits it but the adapter reports credentials
   `NOT_CONFIGURED` → `NOT_CONFIGURED`.
5. `NOT_PERMITTED` always wins over a missing-credentials reading, because the
   remedies differ.

A feature is offered only when **every** capability it requires resolves to
`AVAILABLE`. One missing dependency withholds the feature, and the UI says which
capability blocked it — it does not show a dead button.

## The policy registry

`provider_policies` holds, per provider, a versioned policy: the capability
states, cache `maxCacheSeconds`, forbidden query parameters, destination-host
allowlist and disclosure configuration. Properties:

- **Versioned.** A change writes a new version; a unique index enforces exactly
  one active policy per provider at a time.
- **Operator-editable.** Changed through the admin compliance endpoints, not a
  migration.
- **Audited.** Every change is written to `audit_logs` with who, what and when.

## Kill switches

A kill switch (`capability_kill_switches`) disables a single capability for a
single provider **immediately, without a deploy**, and is audited. It is the
lever an operator pulls the moment a programme raises a concern: engage
`coupons` for AliExpress and every coupon read for AliExpress is refused on the
next request, while search keeps working.

## Capability refusals are events

When a read is refused because a capability is not `AVAILABLE`, the refusal is
recorded as a `compliance_event` and surfaced to the UI as `RESTRICTED` (not an
error). The admin console shows the refusal backlog and counts per provider, and
the `compliance-monitor` worker watches for anomalies. This means "we were asked
to do something we are not permitted to do" is observable, not swallowed.

## The release gate

**The default capability states are conservative starting positions, not legal
advice, and not a claim about what any programme currently permits.** Migration
`0007_seed_providers.sql` seeds them so the system *under*-claims: Amazon's price
history and alerts ship `NOT_PERMITTED`; Temu ships every capability as
`VERIFICATION_REQUIRED`.

Before running in production you must, per provider:

1. Read that programme's **current** terms.
2. Confirm which capabilities it actually permits.
3. Record each decision through the admin compliance review endpoint (which
   audits it), moving a capability to `AVAILABLE` or leaving it restricted.

This is a human review and a release gate, not a code task. The feature-status
register marks `compliance.provider_terms_verification` as `PARTIAL` precisely
because the defaults are conservative and confirming them is your
responsibility, not the code's. Shipping with the defaults is safe (the system
simply offers less); shipping a capability as `AVAILABLE` that the programme
forbids is not, and the product's design pushes you toward the safe default.
