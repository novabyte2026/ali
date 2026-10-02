# Affiliate configuration

Shelf is affiliate-funded: outbound links to a marketplace may carry a tracking
id that credits a qualifying purchase. This is how the product pays for itself,
and it is governed by two rules that are not negotiable:

1. **Commission never influences ranking or recommendations.** There is no code
   path in the ranking module that reads a commission figure; a test asserts the
   word does not even appear in it. What is cheapest, what matches best and what
   is shown first are decided with no knowledge of what pays more.
2. **Disclosure is always visible, and nothing is cloaked.** The destination is
   shown, the relationship is stated on every page that carries monetized links,
   and there are no fake urgency timers, countdowns or dark patterns.

## Configuring tracking

Tracking ids are per provider and set in `.env` (see
[environment.md](environment.md)):

| Provider | Variable |
| -------- | -------- |
| Amazon | `AMAZON_PARTNER_TAG` (e.g. `mytag-20`) |
| AliExpress | `ALIEXPRESS_TRACKING_ID` |
| Temu | `TEMU_AFFILIATE_ID` |

A provider with no tracking id still works — it just produces an honest
**untracked** link. The product never emits a broken or malformed tracking link
to force attribution.

## How a link is built

Links are built by the adapter (`buildAffiliateLink`) and the shared
construction helper (`integrations/src/common/links.ts`), and every link is
checked before it is handed out. The resulting status is one of:

| Status | Meaning |
| ------ | ------- |
| `OK` | Destination on the allowlist, https, tracking id applied. |
| `NOT_CONFIGURED` | No tracking id; the plain store URL is returned, untracked. Any stale tracking parameter already on the URL is **stripped** rather than carried. |
| `BLOCKED` | Destination host is not on the provider's allowlist — refused, not redirected. The tracking id is dropped. |
| `INVALID` | Not https, or the URL carries embedded credentials — rejected. |

The guarantees behind those statuses, each pinned by a unit test:

- **The destination is never hidden.** The link's `destinationHost` is exposed
  so the UI can show where the click goes. No redirect indirection that obscures
  the target.
- **A mis-mapped host cannot become an open redirect.** Host matching allows a
  subdomain of an allowlisted domain (`www.amazon.com` for `amazon.com`) but
  rejects lookalikes (`amazon.com.evil.com`, `notamazon.com`).
- **Forbidden query parameters are stripped** per the provider's policy.
- **A missing tracking id yields an honest untracked link**, not a broken one.

`validateAffiliateLink` additionally flags an `OK` link that somehow lacks a
tracking id (`OK_WITHOUT_TRACKING_ID`), so an inconsistent link is caught rather
than shipped.

## Disclosure

Each provider supplies its own disclosure text per locale via
`getDisclosure(locale)` (for Amazon, the required Associates statement). The
disclosure is:

- shown wherever monetized links appear,
- served to the client at `GET /api/v1/meta/disclosures`,
- summarized publicly at `GET /api/v1/affiliate/transparency`, which states
  which sources are monetized and how the product is funded.

If a provider's disclosure is not configured, affiliate operations for that
provider are refused with `ERROR_DISCLOSURE_NOT_CONFIGURED` — the product will
not place a monetized link it cannot disclose.

## Click tracking and attribution

An outbound click is recorded at `POST /api/v1/affiliate/click` against a
**rotating session hash**, with the placement (where in the UI it was clicked)
and the destination country. Clicks live in `affiliate_clicks`, separate from
personal data and from analytics; the table stores no IP address or user-agent
string in the clear. See [security.md](security.md#data-separation).

## Conversion reporting

Importing programme conversion reports is **marked PLANNED** in the
feature-status register. The schema (`affiliate_conversions`) and the reporting
states exist, but nothing imports a report yet, and the admin UI shows
commission as *estimated* until a real import exists. This is stated honestly
rather than shown as a finished number.
