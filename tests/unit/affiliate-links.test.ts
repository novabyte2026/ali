import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { CapabilityGuard } from '@shelf/integrations';
import { buildAffiliateLinkFromUrl, validateAffiliateLink, hostAllowed } from '@shelf/integrations';

/**
 * Affiliate link construction. The rules pinned here are the ones that keep the
 * product's outbound links honest: the destination is never cloaked, a
 * mis-mapped host cannot become an open redirect, and a missing tracking id
 * yields an honest untracked link rather than a broken one.
 */

function guard(overrides: Partial<CapabilityGuard> = {}): CapabilityGuard {
  return {
    check: () => ({ allowed: true, state: 'AVAILABLE', policyVersion: 'test' }),
    matrix: () => ({}) as never,
    maxCacheSeconds: () => 0,
    persistencePermitted: () => false,
    allowedDestinationHosts: () => ['www.amazon.com', 'amzn.to'],
    forbiddenQueryParams: () => [],
    disclosure: () => 'As an Amazon Associate we may earn from qualifying purchases.',
    policyVersion: 'test',
    ...overrides,
  };
}

test('a configured link carries the tracking parameter', () => {
  const link = buildAffiliateLinkFromUrl({
    providerId: 'amazon',
    destinationUrl: 'https://www.amazon.com/dp/B0DEMO',
    placement: 'SEARCH_RESULT',
    trackingId: 'mytag-20',
    campaignId: null,
    guard: guard(),
    locale: 'en',
    requiredParams: { tag: 'mytag-20' },
  });
  assert.equal(link.status, 'OK');
  assert.ok(link.affiliateUrl.includes('tag=mytag-20'));
  // The destination is shown, not hidden.
  assert.equal(link.destinationHost, 'www.amazon.com');
  assert.equal(link.disclosureRequired, true);
});

test('a destination outside the allowlist is blocked, not redirected', () => {
  const link = buildAffiliateLinkFromUrl({
    providerId: 'amazon',
    destinationUrl: 'https://evil.example.com/phish',
    placement: 'SEARCH_RESULT',
    trackingId: 'mytag-20',
    campaignId: null,
    guard: guard(),
    locale: 'en',
    requiredParams: { tag: 'mytag-20' },
  });
  assert.equal(link.status, 'BLOCKED');
  assert.equal(link.trackingId, null);
});

test('a non-https destination is rejected as invalid', () => {
  const link = buildAffiliateLinkFromUrl({
    providerId: 'amazon',
    destinationUrl: 'http://www.amazon.com/dp/B0DEMO',
    placement: 'SEARCH_RESULT',
    trackingId: 'mytag-20',
    campaignId: null,
    guard: guard(),
    locale: 'en',
    requiredParams: { tag: 'mytag-20' },
  });
  assert.equal(link.status, 'INVALID');
});

test('a URL carrying credentials is rejected', () => {
  const link = buildAffiliateLinkFromUrl({
    providerId: 'amazon',
    destinationUrl: 'https://user:pass@www.amazon.com/dp/B0DEMO',
    placement: 'SEARCH_RESULT',
    trackingId: 'mytag-20',
    campaignId: null,
    guard: guard(),
    locale: 'en',
    requiredParams: { tag: 'mytag-20' },
  });
  assert.equal(link.status, 'INVALID');
});

test('a missing tracking id yields an honest untracked link, not a broken one', () => {
  const link = buildAffiliateLinkFromUrl({
    providerId: 'amazon',
    destinationUrl: 'https://www.amazon.com/dp/B0DEMO?tag=should-be-stripped',
    placement: 'SEARCH_RESULT',
    trackingId: null,
    campaignId: null,
    guard: guard(),
    locale: 'en',
    requiredParams: { tag: null },
  });
  assert.equal(link.status, 'NOT_CONFIGURED');
  assert.equal(link.trackingId, null);
  // The stale tracking parameter is removed rather than carried untracked.
  assert.ok(!link.affiliateUrl.includes('should-be-stripped'));
});

test('validateAffiliateLink flags an OK link with no tracking id', () => {
  const result = validateAffiliateLink(
    {
      providerId: 'amazon',
      destinationUrl: 'https://www.amazon.com/dp/B0DEMO',
      affiliateUrl: 'https://www.amazon.com/dp/B0DEMO',
      trackingId: null,
      campaignId: null,
      placement: 'SEARCH_RESULT',
      status: 'OK',
      disclosureRequired: true,
      disclosureKey: 'disclosure.amazon',
      destinationHost: 'www.amazon.com',
      createdAt: new Date().toISOString(),
    },
    guard(),
  );
  assert.equal(result.valid, false);
  assert.ok(result.problems.includes('OK_WITHOUT_TRACKING_ID'));
});

test('hostAllowed matches subdomains but not lookalikes', () => {
  assert.equal(hostAllowed('www.amazon.com', ['amazon.com']), true);
  assert.equal(hostAllowed('amazon.com', ['amazon.com']), true);
  assert.equal(hostAllowed('amazon.com.evil.com', ['amazon.com']), false);
  assert.equal(hostAllowed('notamazon.com', ['amazon.com']), false);
});
