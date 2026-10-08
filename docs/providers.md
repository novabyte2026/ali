# Providers

A provider is one marketplace affiliate programme. Shelf ships adapters for
**Amazon** (Product Advertising API 5.0 + Associates), **AliExpress** (Open
Platform affiliate APIs) and **Temu** (partner programme). The "All" source mode
fans a query out across whichever of them are available.

Providers are not interchangeable. Each exposes a different set of capabilities,
signs requests differently, and permits different uses of its data. None of that
is assumed — it is resolved per provider at runtime from the adapter's own
configuration and the policy registry (see [compliance.md](compliance.md)).

## The adapter contract

Every adapter implements one interface (`integrations/src/common/adapter.ts`):

```ts
interface ProviderAdapter {
  readonly providerId: ProviderId;
  configuredCapabilities(): Record<Capability, 'CONFIGURED' | 'NOT_CONFIGURED'>;
  searchProducts(request, ctx): Promise<AdapterOutcome<AdapterSearchResult>>;
  getProduct(request, ctx): Promise<AdapterOutcome<{ product; offer }>>;
  getOffers(request, ctx): Promise<AdapterOutcome<NormalizedOffer[]>>;
  getCoupons(request, ctx): Promise<AdapterOutcome<NormalizedCoupon[]>>;
  buildAffiliateLink(request, ctx): Promise<AdapterOutcome<AffiliateLink>>;
  recognizeUrl(url): UrlRecognition;             // pure, offline — fetches nothing
  validateContentUsage(usage, kind, ctx): { permitted; reasonKey };
  getDisclosure(locale, ctx): string | null;
}
```

Two parts of this shape carry the product's guarantees:

### `AdapterOutcome` distinguishes failure from refusal

An operation returns one of three things, never an exception or a null:

- **ok** — a value plus call metadata (duration, HTTP status, whether it was a
  demo fixture, provider request id).
- **failure** — the call was attempted and did not succeed: a timeout, a rate
  limit, an auth rejection, an invalid response. Carries `retryable`.
- **refusal** — the call was **not attempted** because a capability is not
  permitted. Carries the `capability` and an i18n `messageKey`.

The distinction matters because the responses differ: a failure may be retried
or degraded around; a refusal is a policy fact and surfaces to the user as
`RESTRICTED`, not as an error to retry.

### `configuredCapabilities()` is only half the answer

An adapter reports what *it* can determine — whether credentials and endpoints
are present. The backend layers policy and operator state on top and always
takes the **more restrictive** of the two. So an adapter saying a capability is
`CONFIGURED` is necessary but not sufficient; the policy registry can still make
it `NOT_PERMITTED` or a kill switch can make it `DISABLED_BY_OPERATOR`.

### `validateContentUsage` applies restrictions at the boundary

Before the normalizer retains an image, review text or a raw payload, it asks
the adapter whether that content may be used for that purpose
(`DISPLAY` / `PERSIST` / `MODEL_TRAINING` / `EXPORT`). A restriction is therefore
applied where data enters the system, not remembered at render time.

## Resilience

Every outbound call runs through a shared layer (`common/resilience.ts`):

- a **token-bucket rate limiter** per provider (`*_RATE_LIMIT_RPS` /
  `*_RATE_LIMIT_BURST`),
- a **timeout**, and
- a **circuit breaker** that opens after repeated failures so a struggling
  provider is skipped (reported as `CIRCUIT_OPEN`) instead of slowing every
  search.

A provider that fails degrades the result to the sources that answered. It never
fails the whole search, and it never produces fabricated data to fill the gap.

## Amazon

Product Advertising API 5.0. Requests are signed with **AWS Signature Version
4** (`integrations/src/amazon/signer.ts`), verified against the published test
vectors. Requires an approved Associates account; PA-API access and quota grow
with shipped revenue, so the default rate limit is deliberately `1` rps.

Host, region and marketplace are set per Amazon marketplace:

| Marketplace | `AMAZON_HOST` | `AMAZON_REGION` | `AMAZON_MARKETPLACE` |
| ----------- | ------------- | --------------- | -------------------- |
| US | `webservices.amazon.com` | `us-east-1` | `www.amazon.com` |
| UK | `webservices.amazon.co.uk` | `eu-west-1` | `www.amazon.co.uk` |
| Germany | `webservices.amazon.de` | `eu-west-1` | `www.amazon.de` |
| Japan | `webservices.amazon.co.jp` | `us-west-2` | `www.amazon.co.jp` |

(Set the row that matches your Associates account; consult the current PA-API
documentation for the full marketplace list.)

The seed policy ships Amazon's `priceHistory` and `priceAlerts` as
`NOT_PERMITTED` — PA-API terms restrict retaining and republishing historical
price data — so those features are withheld for Amazon until an operator records
a different, verified decision.

## AliExpress

Open Platform affiliate APIs, signed with the **Alibaba TOP** signing scheme
(`integrations/src/aliexpress/signer.ts`). Configure `ALIEXPRESS_APP_KEY`,
`ALIEXPRESS_APP_SECRET`, the gateway and your affiliate `ALIEXPRESS_TRACKING_ID`.

## Temu

Temu's partner API surface is granted per account, and the endpoints and
licensed operations vary by contract. The adapter therefore ships with a
**configurable** base URL and signing, and until you supply them from your own
programme contract, Temu reports `VERIFICATION_REQUIRED` for every capability —
it does not guess an endpoint or a signature. Fill in `TEMU_API_BASE_URL`,
credentials and `TEMU_AFFILIATE_ID` once your contract confirms them, then record
the verified capabilities in the policy registry.

## Demo fixtures

When a provider has no credentials and `ALLOW_DEMO_FIXTURES=true`, a fixture
adapter stands in so the UI is exercisable offline. Every fixture record carries
`dataOrigin=DEMO_FIXTURE`, the call metadata marks `demoFixture: true`, and the
UI shows a persistent demo banner. The backend refuses to boot with fixtures
enabled in production. Fixtures are for development only — they are never a
production fallback.

## Adding a provider

1. Create `integrations/src/<provider>/` with `index.ts` (the adapter),
   `signer.ts`, `mapper.ts` and `types.ts`.
2. Implement `ProviderAdapter`. Map every field through the capability-first
   `mapField` helper so a forbidden field becomes `RESTRICTED` and a missing one
   becomes `UNKNOWN` — never a fabricated value.
3. Register it in `integrations/src/registry.ts`.
4. Add a migration seeding the provider row and a **conservative** default
   policy (prefer `VERIFICATION_REQUIRED` over `AVAILABLE` for anything you have
   not confirmed).
5. Add signer unit tests against the programme's published vectors.
