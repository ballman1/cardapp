/**
 * Historical FX rates for sale-date conversion (§8.3). Default provider is
 * "none" (foreign-currency records are shown separately). Optional
 * "frankfurter" uses ECB reference rates, which return the previous available
 * business day automatically; the actual rate date is preserved.
 */
import type { FxQuote } from '../valuation/normalize.js';

export interface FxService {
  name: string;
  fetchRates(pairs: { from: string; to: string; date: string }[]): Promise<Map<string, FxQuote>>;
}

export const fxKey = (from: string, to: string, date: string) => `${from}:${to}:${date}`;

export function createFxService(provider: 'frankfurter' | 'none', baseUrl: string, fetchImpl: typeof fetch = fetch): FxService {
  if (provider === 'none') {
    return { name: 'none', fetchRates: async () => new Map() };
  }
  const cache = new Map<string, FxQuote>();
  return {
    name: 'frankfurter (ECB reference rates)',
    async fetchRates(pairs) {
      const out = new Map<string, FxQuote>();
      for (const p of pairs) {
        const k = fxKey(p.from, p.to, p.date);
        if (cache.has(k)) {
          out.set(k, cache.get(k)!);
          continue;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || !/^[A-Z]{3}$/.test(p.from) || !/^[A-Z]{3}$/.test(p.to)) continue;
        try {
          const res = await fetchImpl(`${baseUrl}/${p.date}?from=${p.from}&to=${p.to}`, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) continue;
          const body: any = await res.json();
          const rate = body?.rates?.[p.to];
          if (typeof rate !== 'number' || !(rate > 0)) continue;
          const q: FxQuote = { rate, source: 'ECB reference rate via Frankfurter', rateDate: String(body.date ?? p.date) };
          cache.set(k, q);
          out.set(k, q);
        } catch {
          /* leave unresolved → fx_unavailable group */
        }
      }
      return out;
    },
  };
}
