/**
 * Versioned valuation settings (§8). Every ValuationRun persists the full
 * settings object so results are reproducible. These are design judgments
 * pending backtesting — not empirically validated constants.
 */
export const CALC_VERSION = 'valuation-2026.11.01-a';

export interface ValuationSettings {
  calcVersion: string;
  /** Search windows in days, expanded in order while direct evidence is sparse. */
  windowsDays: number[];
  /** Expand the window while fewer than this many Tier A events are eligible. */
  expandBelowCount: number;
  recencyHalfLifeDays: number;
  conditionFactor: { adequate: number; limited: number };
  recordQualityFactor: { original_record: number; feed_complete_fields: number };
  maxCandidateEvents: number;
  bandQuantiles: [number, number];
  strong: { minEvents: number; minEffectiveSample: number };
  moderate: { minEvents: number; minEffectiveSample: number };
  /** Robust z threshold on log price for an outlier *flag* (never an automatic exclusion). */
  outlierRobustZ: number;
  outlierMinSample: number;
  /** Robust log-price dispersion (MAD*1.4826) above which a volatility flag is raised. */
  volatilityLogDispersion: number;
  /** Two records sharing a cert/serial within this many days are flagged as a possible relist. */
  relistWindowDays: number;
}

export const DEFAULT_SETTINGS: ValuationSettings = {
  calcVersion: CALC_VERSION,
  windowsDays: [90, 180, 365, 730],
  expandBelowCount: 8,
  recencyHalfLifeDays: 180,
  conditionFactor: { adequate: 1.0, limited: 0.7 },
  recordQualityFactor: { original_record: 1.0, feed_complete_fields: 0.8 },
  maxCandidateEvents: 100,
  bandQuantiles: [0.2, 0.8],
  strong: { minEvents: 8, minEffectiveSample: 5 },
  moderate: { minEvents: 3, minEffectiveSample: 3 },
  outlierRobustZ: 3.5,
  outlierMinSample: 5,
  volatilityLogDispersion: 0.5,
  relistWindowDays: 30,
};
