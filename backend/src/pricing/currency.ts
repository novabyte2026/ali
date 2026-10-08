import {
  type Datum,
  type ExchangeRate,
  type Money,
  type Provenance,
  estimated,
  isKnown,
  minorUnitFactor,
  money,
  unknown,
} from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config/index.js';

/**
 * Currency conversion.
 *
 * Prices arrive in whichever currency the marketplace quotes, which is often
 * not the currency the user asked for. Converting is necessary for a
 * comparison to mean anything; pretending the conversion is exact is not.
 *
 * So a converted figure:
 *   - carries the rate's as-of date, which the UI shows;
 *   - is downgraded to ESTIMATED when the rate is older than the refresh
 *     window, because a day-old rate is a good approximation and not an
 *     observed price;
 *   - becomes UNKNOWN when no rate exists, rather than falling back to 1.0.
 *     A missing rate silently treated as parity is how a $100 item renders as
 *     ₪100.
 */

export interface CurrencyConverter {
  convert(value: Datum<Money>, target: string): Promise<Datum<Money>>;
  rate(base: string, quote: string): Promise<ExchangeRate | null>;
  refresh(): Promise<number>;
}

/** Rates older than this are still used, but only as an estimate. */
const EXACT_RATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Beyond this a rate is not used at all. */
const USABLE_RATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function createCurrencyConverter(
  db: Database,
  config: AppConfig,
  log: Logger,
): CurrencyConverter {
  // Short-lived in-process cache: a search converts dozens of prices and they
  // must all use the same rate, or two rows of one comparison disagree.
  let cache: { loadedAt: number; rates: Map<string, ExchangeRate> } | null = null;

  async function loadRates(): Promise<Map<string, ExchangeRate>> {
    if (cache && Date.now() - cache.loadedAt < 60_000) return cache.rates;

    const result = await db.query<{
      base_currency: string;
      quote_currency: string;
      rate: string;
      as_of: Date;
      source: string;
    }>(
      `SELECT DISTINCT ON (base_currency, quote_currency)
              base_currency, quote_currency, rate, as_of, source
         FROM exchange_rates
        ORDER BY base_currency, quote_currency, as_of DESC`,
    );

    const rates = new Map<string, ExchangeRate>();
    for (const row of result.rows) {
      rates.set(`${row.base_currency}->${row.quote_currency}`, {
        base: row.base_currency,
        quote: row.quote_currency,
        rate: Number.parseFloat(row.rate),
        asOf: row.as_of.toISOString(),
        source: row.source,
      });
    }

    cache = { loadedAt: Date.now(), rates };
    return rates;
  }

  async function findRate(base: string, quote: string): Promise<ExchangeRate | null> {
    if (base === quote) {
      return { base, quote, rate: 1, asOf: new Date().toISOString(), source: 'identity' };
    }

    const rates = await loadRates();
    const direct = rates.get(`${base}->${quote}`);
    if (direct) return direct;

    const inverse = rates.get(`${quote}->${base}`);
    if (inverse && inverse.rate > 0) {
      return {
        base,
        quote,
        rate: 1 / inverse.rate,
        asOf: inverse.asOf,
        source: `${inverse.source} (inverted)`,
      };
    }

    // Cross rate through USD. Compounds two rates, so the result is dated by
    // the older of the two and is treated as an estimate downstream.
    const baseToUsd = base === 'USD' ? 1 : rates.get(`${base}->USD`)?.rate;
    const usdToQuote = quote === 'USD' ? 1 : rates.get(`USD->${quote}`)?.rate;
    if (baseToUsd && usdToQuote) {
      const asOfCandidates = [
        rates.get(`${base}->USD`)?.asOf,
        rates.get(`USD->${quote}`)?.asOf,
      ].filter((value): value is string => Boolean(value));
      const asOf = asOfCandidates.sort()[0] ?? new Date(0).toISOString();
      return { base, quote, rate: baseToUsd * usdToQuote, asOf, source: 'cross/USD' };
    }

    return null;
  }

  return {
    rate: findRate,

    async convert(value: Datum<Money>, target: string): Promise<Datum<Money>> {
      const targetCurrency = target.toUpperCase();

      if (!isKnown(value)) {
        if (value.state === 'ESTIMATED') {
          const rate = await findRate(value.estimate.low.currency, targetCurrency);
          if (!rate) return unknown<Money>('NOT_COMPUTABLE');
          return estimated<Money>(
            {
              low: applyRate(value.estimate.low, targetCurrency, rate.rate),
              high: applyRate(value.estimate.high, targetCurrency, rate.rate),
              basis: value.estimate.basis,
              confidence: value.estimate.confidence === 'HIGH' ? 'MEDIUM' : value.estimate.confidence,
            },
            withRateProvenance(value.provenance, rate),
          );
        }
        return value;
      }

      if (value.value.currency === targetCurrency) return value;

      const rate = await findRate(value.value.currency, targetCurrency);
      if (!rate) {
        log.warn('No exchange rate available', {
          base: value.value.currency,
          quote: targetCurrency,
        });
        // No rate means no honest figure in the target currency.
        return unknown<Money>('NOT_COMPUTABLE');
      }

      const ageMs = Date.now() - Date.parse(rate.asOf);
      if (ageMs > USABLE_RATE_MAX_AGE_MS) {
        return unknown<Money>('STALE_BEYOND_TOLERANCE');
      }

      const converted = applyRate(value.value, targetCurrency, rate.rate);
      const provenance = withRateProvenance(value.provenance, rate);

      if (ageMs <= EXACT_RATE_MAX_AGE_MS && rate.source !== 'cross/USD') {
        // A fresh direct rate: the figure is as good as the price it came
        // from, but still carries MEDIUM confidence because a conversion is a
        // derivation and the UI should say so.
        return { state: 'KNOWN', value: converted, provenance, confidence: 'MEDIUM' };
      }

      // Older or compounded rate: present as a narrow range rather than a
      // point, so nobody reads it as the price they will be charged.
      const tolerance = rate.source === 'cross/USD' ? 0.02 : 0.01;
      return estimated<Money>(
        {
          low: money(Math.round(converted.minor * (1 - tolerance)), targetCurrency),
          high: money(Math.round(converted.minor * (1 + tolerance)), targetCurrency),
          basis: 'CURRENCY_CONVERTED_AT_DATED_RATE',
          confidence: 'MEDIUM',
        },
        provenance,
      );
    },

    /**
     * Refreshes the rate table. The static driver loads a dated table shipped
     * with the repository, which is honest for development and is refused at
     * boot in production (see config validation).
     */
    async refresh(): Promise<number> {
      const rates =
        config.fx.driver === 'http' ? await fetchHttpRates(config, log) : loadStaticRates();

      if (rates.length === 0) return 0;

      await db.tx(async (client) => {
        for (const entry of rates) {
          await client.query(
            `INSERT INTO exchange_rates (base_currency, quote_currency, rate, as_of, source)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (base_currency, quote_currency, as_of) DO UPDATE
               SET rate = EXCLUDED.rate, fetched_at = now()`,
            [entry.base, entry.quote, entry.rate, entry.asOf, entry.source],
          );
        }
      });

      cache = null;
      log.info('Exchange rates refreshed', { count: rates.length, driver: config.fx.driver });
      return rates.length;
    },
  };
}

function applyRate(value: Money, targetCurrency: string, rate: number): Money {
  // Convert through the decimal amount so differing minor-unit exponents
  // (JPY has none, KWD has three) are handled rather than assumed equal.
  const sourceFactor = minorUnitFactor(value.currency);
  const targetFactor = minorUnitFactor(targetCurrency);
  const decimal = value.minor / sourceFactor;
  return money(Math.round(decimal * rate * targetFactor), targetCurrency);
}

function withRateProvenance(base: Provenance, rate: ExchangeRate): Provenance {
  return {
    ...base,
    origin: 'DERIVED',
    sourceRef: `fx:${rate.base}->${rate.quote}@${rate.asOf}`,
  };
}

async function fetchHttpRates(config: AppConfig, log: Logger): Promise<ExchangeRate[]> {
  try {
    const url = new URL(config.fx.httpUrl);
    const response = await fetch(url, {
      headers: config.fx.httpApiKey ? { authorization: `Bearer ${config.fx.httpApiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      log.error('FX provider returned an error', { status: response.status });
      return [];
    }
    const body = (await response.json()) as {
      base?: string;
      date?: string;
      rates?: Record<string, number>;
    };
    const base = (body.base ?? 'USD').toUpperCase();
    const asOf = body.date ? new Date(body.date).toISOString() : new Date().toISOString();
    return Object.entries(body.rates ?? {})
      .filter(([, rate]) => Number.isFinite(rate) && rate > 0)
      .map(([quote, rate]) => ({
        base,
        quote: quote.toUpperCase(),
        rate,
        asOf,
        source: 'http',
      }));
  } catch (error) {
    log.error('FX refresh failed', { error });
    return [];
  }
}

/**
 * Development rate table.
 *
 * Deliberately dated in the past, so every figure converted with it is shown
 * as an estimate with a visibly old as-of date rather than appearing current.
 * Production refuses to boot with this driver.
 */
function loadStaticRates(): ExchangeRate[] {
  const asOf = '2026-01-02T00:00:00.000Z';
  const fromUsd: Record<string, number> = {
    ILS: 3.62,
    EUR: 0.92,
    GBP: 0.79,
    CAD: 1.36,
    AUD: 1.51,
    USD: 1,
  };

  const rates: ExchangeRate[] = [];
  for (const [quote, rate] of Object.entries(fromUsd)) {
    if (quote === 'USD') continue;
    rates.push({ base: 'USD', quote, rate, asOf, source: 'static-table' });
    rates.push({ base: quote, quote: 'USD', rate: 1 / rate, asOf, source: 'static-table' });
  }
  return rates;
}
