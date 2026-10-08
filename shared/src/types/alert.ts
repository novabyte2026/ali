import type { Money } from '../money.js';
import type { ProviderId } from './provider.js';

/**
 * Alert kinds. Each maps to the capabilities it needs; the API refuses to
 * create one whose provider does not permit the underlying observation, with
 * a plain-language explanation. This is rule 41: do not offer a control that
 * cannot work, and do not quietly create a subscription that never fires.
 */
export const ALERT_KINDS = [
  'PRICE_CHANGE',
  'TARGET_PRICE',
  'NEW_COUPON',
  'NEW_DEAL',
  'AVAILABILITY_CHANGE',
  'DEAL_ENDING',
  'PRICE_ANOMALY',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertChannel = 'EMAIL' | 'IN_APP';

export interface Alert {
  readonly alertId: string;
  readonly userId: string;
  readonly kind: AlertKind;
  readonly providerId: ProviderId | null;
  readonly productGroupId: string | null;
  readonly providerProductId: string | null;
  /** For TARGET_PRICE. */
  readonly targetPrice: Money | null;
  /** For PRICE_CHANGE: minimum move, in percent, before notifying. */
  readonly thresholdPercent: number | null;
  readonly channels: ReadonlyArray<AlertChannel>;
  readonly active: boolean;
  readonly createdAt: string;
  readonly lastTriggeredAt: string | null;
  /** Set when a capability change suspended the alert after creation. */
  readonly suspendedReason: string | null;
}

export interface AlertEvent {
  readonly eventId: string;
  readonly alertId: string;
  readonly userId: string;
  readonly kind: AlertKind;
  readonly triggeredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly deliveredChannels: ReadonlyArray<AlertChannel>;
  readonly readAt: string | null;
}

/** Capabilities each alert kind depends on, checked before creation. */
export const ALERT_CAPABILITY_REQUIREMENTS: Readonly<Record<AlertKind, ReadonlyArray<string>>> = {
  PRICE_CHANGE: ['priceAlerts', 'priceHistory', 'persistProviderData'],
  TARGET_PRICE: ['priceAlerts', 'currentPrice', 'persistProviderData'],
  NEW_COUPON: ['coupons', 'persistProviderData'],
  NEW_DEAL: ['deals', 'persistProviderData'],
  AVAILABILITY_CHANGE: ['availability', 'persistProviderData'],
  DEAL_ENDING: ['deals'],
  PRICE_ANOMALY: ['priceHistory', 'persistProviderData'],
};
