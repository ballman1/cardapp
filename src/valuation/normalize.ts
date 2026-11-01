/**
 * Price-basis normalization (§8.3).
 *
 * Headline basis: reported buyer acquisition price before shipping and tax,
 * including buyer premium when applicable.
 *
 * Rules:
 *  - Never add a buyer premium that is already included.
 *  - Apply a premium only when it is evidenced for that specific sale.
 *  - Never treat a missing fee as zero; unresolvable records go to a separate
 *    price-basis group rather than receiving a fabricated normalization.
 *  - Convert currency with a documented historical rate for the sale date.
 */
import type { SaleRecord } from '../domain/types.js';

export const HEADLINE_BASIS_LABEL =
  'Reported buyer acquisition price before shipping and tax, including buyer premium when applicable';

export interface FxQuote {
  /** Units of target currency per 1 unit of source currency. */
  rate: number;
  source: string;
  /** Date of the rate actually used (may be the previous business day). */
  rateDate: string;
}

export type FxLookup = (fromCurrency: string, toCurrency: string, saleDate: string) => FxQuote | null;

export type BasisGroup =
  | 'headline'
  | 'hammer_premium_unknown'
  | 'shipping_included_unknown_amount'
  | 'basis_unknown'
  | 'fx_unavailable'
  | 'amount_missing';

export interface NormalizationResult {
  basisGroup: BasisGroup;
  /** Headline-basis amount in source currency, minor units (null unless resolvable). */
  sourceAmountMinor: number | null;
  /** Normalized amount in valuation currency, minor units, full precision (float allowed internally). */
  normalizedMinor: number | null;
  fx: FxQuote | null;
  assumptions: string[];
}

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'CLP', 'VND', 'ISK', 'HUF']);
/** ISO 4217 minor-unit exponent (subset; 2 is the default). */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

const NO_PREMIUM_FORMATS = new Set(['fixed_price', 'best_offer', 'marketplace_auction']);

export function normalizePrice(rec: SaleRecord, targetCurrency: string, fx: FxLookup): NormalizationResult {
  const assumptions: string[] = [];
  if (rec.reportedAmountMinor == null) {
    return { basisGroup: 'amount_missing', sourceAmountMinor: null, normalizedMinor: null, fx: null, assumptions: ['No reported amount; nothing invented.'] };
  }
  let amount: number | null = null;
  let group: BasisGroup = 'headline';

  switch (rec.priceBasis) {
    case 'hammer_plus_premium':
      amount = rec.reportedAmountMinor;
      assumptions.push('Reported amount already includes buyer premium; premium not added again.');
      break;
    case 'item_price':
      if (NO_PREMIUM_FORMATS.has(rec.saleFormat)) {
        amount = rec.reportedAmountMinor;
        assumptions.push('Marketplace item price excluding shipping/tax; venue format carries no buyer premium.');
      } else if (rec.buyerPremiumMinor != null) {
        amount = rec.reportedAmountMinor + rec.buyerPremiumMinor;
        assumptions.push('Added sale-specific buyer premium reported in the record.');
      } else {
        // An item price at an auction venue with unknown premium status.
        group = 'hammer_premium_unknown';
        assumptions.push('Auction-format item price with no evidence about buyer premium; kept in a separate basis group.');
      }
      break;
    case 'hammer':
      if (rec.buyerPremiumMinor != null) {
        amount = rec.reportedAmountMinor + rec.buyerPremiumMinor;
        assumptions.push('Hammer price plus the sale-specific buyer premium amount reported in the record.');
      } else if (rec.buyerPremiumRate != null && rec.buyerPremiumEvidence) {
        amount = rec.reportedAmountMinor * (1 + rec.buyerPremiumRate);
        assumptions.push(`Hammer price plus evidenced sale-specific premium rate ${(rec.buyerPremiumRate * 100).toFixed(2)}% (${rec.buyerPremiumEvidence}).`);
      } else {
        group = 'hammer_premium_unknown';
        assumptions.push('Hammer-only amount with no evidenced premium; no house-wide flat rate assumed.');
      }
      break;
    case 'total_including_shipping':
      if (rec.shippingMinor != null && (rec.taxMinor != null)) {
        amount = rec.reportedAmountMinor - rec.shippingMinor - rec.taxMinor;
        assumptions.push('Subtracted reported shipping and tax from total.');
      } else {
        group = 'shipping_included_unknown_amount';
        assumptions.push('Total includes shipping/tax of unknown amount; missing amounts are not assumed to be zero.');
      }
      break;
    default:
      group = 'basis_unknown';
      assumptions.push('Price basis unknown; kept outside the headline pool.');
  }

  if (group !== 'headline' || amount == null) {
    return { basisGroup: group, sourceAmountMinor: null, normalizedMinor: null, fx: null, assumptions };
  }

  if (rec.currency.toUpperCase() === targetCurrency.toUpperCase()) {
    return { basisGroup: 'headline', sourceAmountMinor: amount, normalizedMinor: amount, fx: null, assumptions };
  }
  const quote = fx(rec.currency.toUpperCase(), targetCurrency.toUpperCase(), rec.saleDate.slice(0, 10));
  if (!quote) {
    assumptions.push(`No documented ${rec.currency}→${targetCurrency} rate for ${rec.saleDate.slice(0, 10)}; original record shown separately.`);
    return { basisGroup: 'fx_unavailable', sourceAmountMinor: amount, normalizedMinor: null, fx: null, assumptions };
  }
  assumptions.push(`Converted ${rec.currency}→${targetCurrency} at ${quote.rate} (${quote.source}, rate date ${quote.rateDate}).`);
  const normalizedMinor = (amount / 10 ** currencyExponent(rec.currency)) * quote.rate * 10 ** currencyExponent(targetCurrency);
  return { basisGroup: 'headline', sourceAmountMinor: amount, normalizedMinor, fx: quote, assumptions };
}
