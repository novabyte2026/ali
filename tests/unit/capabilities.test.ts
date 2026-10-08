import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  type CapabilityMatrix,
  CAPABILITIES,
  emptyMatrix,
  evaluateFeature,
  isCapabilityAllowed,
} from '@shelf/shared';
import { narrowMatrix } from '@shelf/backend';

/**
 * Capability resolution. The narrowing order is load-bearing: a permission we
 * do not hold must read as not-permitted even when credentials also happen to
 * be missing, because the fix for the former is a legal review and the fix for
 * the latter is a deployment change.
 */

function declared(overrides: Partial<CapabilityMatrix> = {}): CapabilityMatrix {
  return { ...emptyMatrix('AVAILABLE'), ...overrides };
}

test('only AVAILABLE permits use', () => {
  assert.equal(isCapabilityAllowed('AVAILABLE'), true);
  assert.equal(isCapabilityAllowed('NOT_PERMITTED'), false);
  assert.equal(isCapabilityAllowed('VERIFICATION_REQUIRED'), false);
  assert.equal(isCapabilityAllowed('NOT_CONFIGURED'), false);
  assert.equal(isCapabilityAllowed('DISABLED_BY_OPERATOR'), false);
});

test('a disabled provider disables everything', () => {
  const matrix = narrowMatrix({
    declared: declared(),
    providerEnabled: false,
    engagedKillSwitches: new Set(),
    configured: undefined,
  });
  for (const capability of CAPABILITIES) {
    assert.equal(matrix[capability], 'DISABLED_BY_OPERATOR');
  }
});

test('a kill switch overrides an otherwise available capability', () => {
  const matrix = narrowMatrix({
    declared: declared(),
    providerEnabled: true,
    engagedKillSwitches: new Set(['coupons']),
    configured: undefined,
  });
  assert.equal(matrix.coupons, 'DISABLED_BY_OPERATOR');
  assert.equal(matrix.search, 'AVAILABLE');
});

test('NOT_PERMITTED wins over missing credentials', () => {
  // The important ordering case. A capability the policy forbids must not be
  // reported as merely NOT_CONFIGURED, because that would suggest the fix is to
  // add credentials rather than to not do it at all.
  const configured: Record<string, 'CONFIGURED' | 'NOT_CONFIGURED'> = {} as never;
  for (const capability of CAPABILITIES) configured[capability] = 'NOT_CONFIGURED';

  const matrix = narrowMatrix({
    declared: declared({ priceHistory: 'NOT_PERMITTED' }),
    providerEnabled: true,
    engagedKillSwitches: new Set(),
    configured,
  });
  assert.equal(matrix.priceHistory, 'NOT_PERMITTED');
});

test('a permitted-but-unconfigured capability reads as NOT_CONFIGURED', () => {
  const configured: Record<string, 'CONFIGURED' | 'NOT_CONFIGURED'> = {} as never;
  for (const capability of CAPABILITIES) configured[capability] = 'NOT_CONFIGURED';

  const matrix = narrowMatrix({
    declared: declared(),
    providerEnabled: true,
    engagedKillSwitches: new Set(),
    configured,
  });
  assert.equal(matrix.search, 'NOT_CONFIGURED');
});

test('a feature is offered only when every required capability is available', () => {
  // Price alerts need priceAlerts, currentPrice (via requirements) and
  // persistProviderData. One missing is enough to withhold the feature.
  const matrix = emptyMatrix('AVAILABLE') as Record<string, CapabilityMatrix[keyof CapabilityMatrix]>;
  matrix.priceAlerts = 'NOT_PERMITTED';

  const verdict = evaluateFeature('priceAlert', 'amazon', matrix as CapabilityMatrix);
  assert.equal(verdict.enabled, false);
  assert.ok(verdict.blockedBy.some((b) => b.capability === 'priceAlerts'));
});
