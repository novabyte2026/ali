import type { ConfidenceBand } from '../datum.js';
import type { Money } from '../money.js';
import type { ProviderId } from './provider.js';

/**
 * A single retained price observation. Written only for providers whose
 * `priceHistory` and `persistProviderData` capabilities are AVAILABLE — which
 * is why a history chart is present for some sources and honestly absent for
 * others rather than being filled in with interpolation.
 */
export interface PriceObservation {
  readonly observationId: string;
  readonly providerId: ProviderId;
  readonly providerProductId: string;
  readonly providerVariantId: string | null;
  readonly priceMinor: number;
  readonly currency: string;
  readonly availability: string;
  readonly observedAt: string;
  readonly dataOrigin: string;
  readonly confidence: ConfidenceBand;
}

export interface PriceSeriesPoint {
  readonly at: string;
  readonly price: Money;
  readonly availability: string;
}

export interface PriceSeries {
  readonly providerId: ProviderId;
  readonly providerProductId: string;
  readonly providerVariantId: string | null;
  readonly currency: string;
  readonly points: ReadonlyArray<PriceSeriesPoint>;
  readonly windowStart: string;
  readonly windowEnd: string;
  /**
   * How many observations back the series. A chart drawn from three points in
   * ninety days is labelled sparse rather than presented as a trend line.
   */
  readonly sampleCount: number;
  readonly sparse: boolean;
}

export interface PriceStatistics {
  readonly lowest: Money | null;
  readonly highest: Money | null;
  readonly median: Money | null;
  readonly current: Money | null;
  /** Percentile of the current price within the retained window, 0..100. */
  readonly currentPercentile: number | null;
  readonly sampleCount: number;
}

/** FX rate with its own provenance, so a converted figure can be dated. */
export interface ExchangeRate {
  readonly base: string;
  readonly quote: string;
  readonly rate: number;
  readonly asOf: string;
  readonly source: string;
}
