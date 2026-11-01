/** Deterministic statistics helpers used by the valuation engine (§8.4–8.5). */

export interface Weighted {
  value: number;
  weight: number;
}

/**
 * Weighted quantile: the smallest sorted value whose cumulative weight reaches
 * at least p × total weight. Ties in value are broken by input order (stable sort)
 * so the result is fully deterministic.
 */
export function weightedQuantile(items: Weighted[], p: number): number {
  if (items.length === 0) throw new Error('weightedQuantile: empty input');
  if (p < 0 || p > 1) throw new Error('weightedQuantile: p out of range');
  const sorted = items
    .map((it, i) => ({ ...it, i }))
    .sort((a, b) => a.value - b.value || a.i - b.i);
  const total = sorted.reduce((s, it) => s + it.weight, 0);
  if (!(total > 0)) throw new Error('weightedQuantile: non-positive total weight');
  const target = p * total;
  let cum = 0;
  for (const it of sorted) {
    cum += it.weight;
    // Small tolerance guards against floating-point accumulation error only.
    if (cum >= target - 1e-12 * total) return it.value;
  }
  return sorted[sorted.length - 1]!.value;
}

export const weightedMedian = (items: Weighted[]) => weightedQuantile(items, 0.5);

/** Plain (unweighted) median — mean of the two middle values for even counts. */
export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median: empty input');
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Kish effective sample size: (Σw)² / Σw². */
export function effectiveSampleSize(weights: number[]): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  const sumSq = weights.reduce((a, b) => a + b * b, 0);
  return sumSq > 0 ? (sum * sum) / sumSq : 0;
}

/** Median absolute deviation. */
export function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** Robust z-scores on log price (Iglewicz–Hoaglin modified z). Returns null when MAD is 0. */
export function robustLogZ(values: number[]): (number | null)[] {
  const logs = values.map((v) => Math.log(v));
  const m = median(logs);
  const d = mad(logs);
  if (d === 0) return logs.map(() => null);
  return logs.map((l) => (0.6745 * (l - m)) / d);
}

/** Robust dispersion of log prices (MAD × 1.4826 ≈ σ under normality). */
export function robustLogDispersion(values: number[]): number {
  if (values.length < 2) return 0;
  return mad(values.map((v) => Math.log(v))) * 1.4826;
}

/** Recency weight 2^(−age/H). */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  return Math.pow(2, -Math.max(0, ageDays) / halfLifeDays);
}

/**
 * Round a minor-unit amount for display at a precision consistent with the
 * evidence. Broad/limited evidence gets coarser rounding. Internal values are
 * never rounded.
 */
export function displayRoundMinor(minor: number, strength: 'strong' | 'moderate' | 'limited'): number {
  const major = minor / 100;
  if (major <= 0) return 0;
  const sig = strength === 'strong' ? 3 : 2;
  const magnitude = Math.pow(10, Math.floor(Math.log10(major)) - sig + 1);
  const step = Math.max(1, magnitude); // never finer than whole currency units
  return Math.round(major / step) * step * 100;
}
