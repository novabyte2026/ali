import type { AffiliateLink, LinkPlacement } from '@shelf/shared';
import type { CapabilityGuard } from './adapter.js';

/**
 * Affiliate link construction, with the programme's rules applied at the point
 * of construction rather than remembered later.
 *
 * What this enforces:
 *   - Destination must be https and must be on a host the provider's policy
 *     lists. A mis-mapped provider field cannot turn our outbound click into
 *     an open redirect.
 *   - Parameters the programme forbids are stripped.
 *   - No cloaking. `destinationHost` is computed and shown to the user before
 *     they click, and we never replace the destination with an opaque shortener
 *     of our own.
 *   - When the programme is unconfigured, the plain store URL is returned with
 *     status NOT_CONFIGURED. An untracked visit is a lost commission; a
 *     malformed tracking link is a terms problem. We take the former.
 */

export interface LinkBuildInput {
  readonly providerId: string;
  readonly destinationUrl: string;
  readonly placement: LinkPlacement;
  readonly trackingId: string | null;
  readonly campaignId: string | null;
  readonly guard: CapabilityGuard;
  readonly locale: string;
  /**
   * Parameters this programme's link format requires, e.g. `{ tag: 'id-20' }`.
   * Applied only when every value is non-empty.
   */
  readonly requiredParams?: Readonly<Record<string, string | null>>;
}

export function buildAffiliateLinkFromUrl(input: LinkBuildInput): AffiliateLink {
  const createdAt = new Date().toISOString();
  const parsed = safeParseHttpsUrl(input.destinationUrl);

  if (!parsed) {
    return {
      providerId: input.providerId,
      destinationUrl: input.destinationUrl,
      affiliateUrl: input.destinationUrl,
      trackingId: null,
      campaignId: null,
      placement: input.placement,
      status: 'INVALID',
      disclosureRequired: true,
      disclosureKey: null,
      destinationHost: '',
      createdAt,
    };
  }

  if (!hostAllowed(parsed.hostname, input.guard.allowedDestinationHosts())) {
    return {
      providerId: input.providerId,
      destinationUrl: parsed.toString(),
      affiliateUrl: parsed.toString(),
      trackingId: null,
      campaignId: null,
      placement: input.placement,
      status: 'BLOCKED',
      disclosureRequired: true,
      disclosureKey: null,
      destinationHost: parsed.hostname,
      createdAt,
    };
  }

  const disclosure = input.guard.disclosure(input.locale);

  // Strip anything the programme forbids us from sending.
  const affiliate = new URL(parsed.toString());
  for (const forbidden of input.guard.forbiddenQueryParams()) {
    affiliate.searchParams.delete(forbidden);
  }

  const required = input.requiredParams ?? {};
  const missingRequired = Object.entries(required).filter(
    ([, value]) => !value || value.trim().length === 0,
  );

  if (missingRequired.length > 0) {
    // Not configured: hand back the clean store URL. The click is untracked and
    // recorded as such, which is visible in the admin console.
    return {
      providerId: input.providerId,
      destinationUrl: parsed.toString(),
      affiliateUrl: stripTracking(parsed, Object.keys(required)).toString(),
      trackingId: null,
      campaignId: input.campaignId,
      placement: input.placement,
      status: 'NOT_CONFIGURED',
      disclosureRequired: Boolean(disclosure),
      disclosureKey: disclosure ? `disclosure.${input.providerId}` : null,
      destinationHost: parsed.hostname,
      createdAt,
    };
  }

  for (const [name, value] of Object.entries(required)) {
    if (value) affiliate.searchParams.set(name, value);
  }

  return {
    providerId: input.providerId,
    destinationUrl: parsed.toString(),
    affiliateUrl: affiliate.toString(),
    trackingId: input.trackingId,
    campaignId: input.campaignId,
    placement: input.placement,
    status: 'OK',
    disclosureRequired: Boolean(disclosure),
    disclosureKey: disclosure ? `disclosure.${input.providerId}` : null,
    destinationHost: parsed.hostname,
    createdAt,
  };
}

/**
 * Wraps a link the provider's own link API produced. Used by programmes that
 * require generation through their tooling rather than parameter appending —
 * the generated URL is validated but never rewritten.
 */
export function wrapProviderGeneratedLink(input: {
  readonly providerId: string;
  readonly destinationUrl: string;
  readonly generatedUrl: string;
  readonly placement: LinkPlacement;
  readonly trackingId: string | null;
  readonly campaignId: string | null;
  readonly guard: CapabilityGuard;
  readonly locale: string;
}): AffiliateLink {
  const createdAt = new Date().toISOString();
  const destination = safeParseHttpsUrl(input.destinationUrl);
  const generated = safeParseHttpsUrl(input.generatedUrl);
  const disclosure = input.guard.disclosure(input.locale);
  const allowed = input.guard.allowedDestinationHosts();

  if (!destination || !generated) {
    return {
      providerId: input.providerId,
      destinationUrl: input.destinationUrl,
      affiliateUrl: input.destinationUrl,
      trackingId: null,
      campaignId: null,
      placement: input.placement,
      status: 'INVALID',
      disclosureRequired: true,
      disclosureKey: null,
      destinationHost: destination?.hostname ?? '',
      createdAt,
    };
  }

  // The generated link's own host must also be on the allowlist: programmes
  // use dedicated click hosts, and those belong in the policy record rather
  // than being accepted implicitly.
  const generatedHostAllowed = hostAllowed(generated.hostname, allowed);

  return {
    providerId: input.providerId,
    destinationUrl: destination.toString(),
    affiliateUrl: generatedHostAllowed ? generated.toString() : destination.toString(),
    trackingId: generatedHostAllowed ? input.trackingId : null,
    campaignId: input.campaignId,
    placement: input.placement,
    status: generatedHostAllowed ? 'OK' : 'INVALID',
    disclosureRequired: Boolean(disclosure),
    disclosureKey: disclosure ? `disclosure.${input.providerId}` : null,
    destinationHost: destination.hostname,
    createdAt,
  };
}

/** A link with no tracking at all, for providers whose programme is pending. */
export function untrackedLink(input: {
  readonly providerId: string;
  readonly destinationUrl: string;
  readonly placement: LinkPlacement;
  readonly guard: CapabilityGuard;
  readonly locale: string;
  readonly status: AffiliateLink['status'];
}): AffiliateLink {
  const parsed = safeParseHttpsUrl(input.destinationUrl);
  const disclosure = input.guard.disclosure(input.locale);
  const url = parsed ? stripTracking(parsed, []).toString() : input.destinationUrl;
  return {
    providerId: input.providerId,
    destinationUrl: url,
    affiliateUrl: url,
    trackingId: null,
    campaignId: null,
    placement: input.placement,
    status: input.status,
    disclosureRequired: Boolean(disclosure),
    disclosureKey: disclosure ? `disclosure.${input.providerId}` : null,
    destinationHost: parsed?.hostname ?? '',
    createdAt: new Date().toISOString(),
  };
}

function safeParseHttpsUrl(raw: string): URL | null {
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  // Credentials in a URL are never legitimate here and are a phishing vector.
  if (parsed.username || parsed.password) return null;
  return parsed;
}

export function hostAllowed(host: string, allowed: ReadonlyArray<string>): boolean {
  if (allowed.length === 0) return false;
  const needle = host.toLowerCase();
  return allowed.some((entry) => {
    const candidate = entry.toLowerCase();
    return needle === candidate || needle.endsWith(`.${candidate}`);
  });
}

/**
 * Removes our own tracking parameters from a URL that is about to be presented
 * as untracked, so an "untracked" link really is one.
 */
function stripTracking(url: URL, names: ReadonlyArray<string>): URL {
  const out = new URL(url.toString());
  for (const name of names) out.searchParams.delete(name);
  for (const name of ['tag', 'aff_short_key', 'aff_platform', 'aff_trace_key', 'ref', 'ref_']) {
    out.searchParams.delete(name);
  }
  return out;
}

/**
 * Link integrity check used by the compliance monitor worker. A link that
 * fails any of these is reported rather than quietly served.
 */
export function validateAffiliateLink(
  link: AffiliateLink,
  guard: CapabilityGuard,
): { readonly valid: boolean; readonly problems: ReadonlyArray<string> } {
  const problems: string[] = [];

  const destination = safeParseHttpsUrl(link.destinationUrl);
  const affiliate = safeParseHttpsUrl(link.affiliateUrl);

  if (!destination) problems.push('DESTINATION_NOT_HTTPS');
  if (!affiliate) problems.push('AFFILIATE_URL_NOT_HTTPS');

  if (destination && !hostAllowed(destination.hostname, guard.allowedDestinationHosts())) {
    problems.push('DESTINATION_HOST_NOT_ALLOWED');
  }
  if (affiliate && !hostAllowed(affiliate.hostname, guard.allowedDestinationHosts())) {
    problems.push('AFFILIATE_HOST_NOT_ALLOWED');
  }

  for (const forbidden of guard.forbiddenQueryParams()) {
    if (affiliate?.searchParams.has(forbidden)) problems.push(`FORBIDDEN_PARAM_${forbidden}`);
  }

  if (link.status === 'OK' && !link.trackingId) problems.push('OK_WITHOUT_TRACKING_ID');
  if (link.disclosureRequired && !link.disclosureKey) problems.push('DISCLOSURE_NOT_CONFIGURED');
  if (!link.destinationHost) problems.push('DESTINATION_HOST_NOT_SHOWN');

  return { valid: problems.length === 0, problems };
}
