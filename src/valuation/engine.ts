/**
 * Deterministic valuation engine (§8). Pure function: same inputs + settings
 * → identical output. The language model never computes prices; it only
 * explains this frozen result.
 */
import type { SaleRecord } from '../domain/types.js';
import { DEFAULT_SETTINGS, type ValuationSettings } from './settings.js';
import { classify, describeGrade, EXCLUSION_TEXT, type ExclusionReason, type SubjectCard, type Tier } from './eligibility.js';
import { dedupe } from './dedupe.js';
import { HEADLINE_BASIS_LABEL, normalizePrice, type BasisGroup, type FxLookup, type FxQuote } from './normalize.js';
import {
  displayRoundMinor,
  effectiveSampleSize,
  median,
  recencyWeight,
  robustLogDispersion,
  robustLogZ,
  weightedMedian,
  weightedQuantile,
} from './stats.js';

export interface GuideBenchmark {
  provider: string;
  label: string;
  valueMinor: number;
  currency: string;
  asOf: string;
  note: string;
}

export interface ValuationGates {
  identityResolved: boolean;
  identityIssues: string[];
  /** 'unresolved_material' when e.g. a cert mismatch or unauthenticated material autograph claim changes value. */
  authenticity: 'resolved' | 'not_material' | 'unresolved_material';
  authenticityIssues: string[];
  /** Explicit scenario under which a conditional estimate may be shown. */
  conditionalScenario: string | null;
}

export interface ValuationInput {
  subject: SubjectCard;
  records: SaleRecord[];
  valuationDate: string; // ISO
  currency: string;
  fx: FxLookup;
  gates: ValuationGates;
  userExcludedEvidenceIds?: string[];
  guideBenchmarks?: GuideBenchmark[];
  retrievalTruncated?: boolean;
  settings?: ValuationSettings;
}

export type Pool = 'precise' | 'broad';

export interface RecordAssessment {
  evidenceId: string;
  tier: Tier | null;
  mismatchedFields: string[];
  exclusions: ExclusionReason[];
  exclusionText: string[];
  notes: string[];
  basisGroup: BasisGroup;
  normalizationAssumptions: string[];
  sourceAmountMinor: number | null;
  normalizedMinor: number | null;
  fx: FxQuote | null;
  ageDays: number;
  duplicateGroupId: string;
  isPrimary: boolean;
  correlationClusterId: string;
  pool: Pool | null;
  weight: number | null;
  factors: { recency: number; condition: number; recordQuality: number } | null;
  robustZ: number | null;
  flags: string[];
  gradeLabel: string;
}

export interface PoolSummary {
  eventCount: number;
  independentEventCount: number;
  effectiveSampleSize: number;
  weightedMedianMinor: number | null;
  unweightedMedianMinor: number | null;
  band: { kind: 'recent_comparable_sales_band_p20_p80' | 'observed_range' | 'limited_range'; lowMinor: number; highMinor: number } | null;
  logDispersion: number;
  evidenceIds: string[];
}

export type Strength = 'strong' | 'moderate' | 'limited' | 'insufficient';

export interface Headline {
  kind: 'estimate' | 'tentative' | 'limited' | 'insufficient' | 'broad_indication_only' | 'suppressed' | 'conditional';
  centralMinor: number | null;
  lowMinor: number | null;
  highMinor: number | null;
  display: { central: number | null; low: number | null; high: number | null };
  statement: string;
  scenario: string | null;
}

export interface ScenarioGroup {
  label: string;
  count: number;
  medianMinor: number | null;
  lowMinor: number | null;
  highMinor: number | null;
  evidenceIds: string[];
}

export interface ValuationResult {
  calcVersion: string;
  settings: ValuationSettings;
  valuationDate: string;
  currency: string;
  priceBasis: string;
  subjectGrade: string;
  window: { selectedDays: number; expansions: { days: number; directEvents: number }[]; olderThanMaxCount: number };
  records: RecordAssessment[];
  precise: PoolSummary;
  broad: PoolSummary;
  strength: Strength;
  headline: Headline;
  confidence: {
    identity: string;
    conditionVisibility: string;
    authenticity: string;
    marketEvidence: Strength;
  };
  flags: string[];
  scenarioGroups: ScenarioGroup[];
  analogEvidenceIds: string[];
  separateBasisGroups: { group: BasisGroup; evidenceIds: string[] }[];
  guideBenchmarks: GuideBenchmark[];
  duplicateGroups: { groupId: string; primaryEvidenceId: string; memberEvidenceIds: string[]; reasons: string[] }[];
  retrievalTruncated: boolean;
  containsFixtureData: boolean;
  containsOwnerSuppliedEvidence: boolean;
  outlierImpact: string | null;
  reportState: 'ready' | 'limited_evidence' | 'conditional';
}

const DAY_MS = 86_400_000;

function emptyPool(): PoolSummary {
  return { eventCount: 0, independentEventCount: 0, effectiveSampleSize: 0, weightedMedianMinor: null, unweightedMedianMinor: null, band: null, logDispersion: 0, evidenceIds: [] };
}

export function runValuation(input: ValuationInput): ValuationResult {
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const valuationTime = Date.parse(input.valuationDate);
  const userExcluded = new Set(input.userExcludedEvidenceIds ?? []);
  const flags: string[] = [];

  // Deterministic order: newest first, then evidence id.
  const ordered = [...input.records].sort(
    (a, b) => Date.parse(b.saleDate) - Date.parse(a.saleDate) || (a.evidenceId < b.evidenceId ? -1 : 1),
  );
  const truncatedIds = new Set(ordered.slice(settings.maxCandidateEvents).map((r) => r.evidenceId));
  const retrievalTruncated = !!input.retrievalTruncated || truncatedIds.size > 0;
  if (retrievalTruncated) flags.push(`Retrieval truncated at the ${settings.maxCandidateEvents}-event cap; coverage is not complete.`);

  const dd = dedupe(ordered, settings.relistWindowDays);

  const assess: RecordAssessment[] = ordered.map((rec) => {
    const c = classify(input.subject, rec);
    const n = normalizePrice(rec, input.currency, input.fx);
    const exclusions = [...c.exclusions];
    const gid = dd.groupOf.get(rec.evidenceId)!;
    const group = dd.groups.find((g) => g.groupId === gid)!;
    const isPrimary = group.primaryEvidenceId === rec.evidenceId;
    if (!isPrimary) exclusions.push('duplicate');
    if (n.basisGroup !== 'headline') exclusions.push('price_basis_unresolved');
    if (userExcluded.has(rec.evidenceId)) exclusions.push('user_flagged');
    if (truncatedIds.has(rec.evidenceId)) exclusions.push('truncated');
    const recFlags: string[] = [];
    const relist = dd.relistFlags.get(gid);
    if (relist) recFlags.push(relist);
    if (rec.relisted) recFlags.push('Source marks this item as relisted.');
    if (rec.paymentStatus === 'unknown') recFlags.push('Payment/settlement not confirmed by source; reported sale only.');
    if (rec.acquisitionMethod === 'owner_supplied') recFlags.push('Owner-supplied evidence; not independently verified.');
    if (rec.isFixture) recFlags.push('FIXTURE — synthetic test data, not a real sale.');
    return {
      evidenceId: rec.evidenceId,
      tier: c.tier,
      mismatchedFields: c.mismatchedFields,
      exclusions,
      exclusionText: [],
      notes: c.notes,
      basisGroup: n.basisGroup,
      normalizationAssumptions: n.assumptions,
      sourceAmountMinor: n.sourceAmountMinor,
      normalizedMinor: n.normalizedMinor,
      fx: n.fx,
      ageDays: Math.max(0, (valuationTime - Date.parse(rec.saleDate)) / DAY_MS),
      duplicateGroupId: gid,
      isPrimary,
      correlationClusterId: dd.clusterOf.get(gid)!,
      pool: null,
      weight: null,
      factors: null,
      robustZ: null,
      flags: recFlags,
      gradeLabel: describeGrade(rec.grade),
    };
  });
  const recById = new Map(ordered.map((r) => [r.evidenceId, r]));
  const rawPoolOf = new Map(ordered.map((r) => [r.evidenceId, classify(input.subject, r).rawPool]));

  // Tier A records that pass every exclusion are window candidates.
  const directCandidates = assess.filter((a) => a.tier === 'A' && a.exclusions.length === 0);
  const eventsWithin = (days: number, list: RecordAssessment[]) => new Set(list.filter((a) => a.ageDays <= days).map((a) => a.duplicateGroupId)).size;

  const expansions: { days: number; directEvents: number }[] = [];
  let selectedDays = settings.windowsDays[settings.windowsDays.length - 1]!;
  for (const days of settings.windowsDays) {
    const count = eventsWithin(days, directCandidates);
    expansions.push({ days, directEvents: count });
    if (count >= settings.expandBelowCount) {
      selectedDays = days;
      break;
    }
  }
  const maxDays = settings.windowsDays[settings.windowsDays.length - 1]!;
  let olderThanMax = 0;
  for (const a of assess) {
    if (a.ageDays > selectedDays) {
      a.exclusions.push('outside_window');
      if (a.ageDays > maxDays) {
        olderThanMax++;
        a.flags.push(`Stale: older than ${maxDays} days; contextual only.`);
      }
    }
  }

  // Assign pools and weights.
  for (const a of assess) {
    if (a.tier !== 'A' || a.exclusions.length > 0) continue;
    const rec = recById.get(a.evidenceId)!;
    const pool: Pool = input.subject.grade.state === 'raw' && rawPoolOf.get(a.evidenceId) !== 'precise' ? 'broad' : 'precise';
    const conditionFactor =
      pool === 'broad' ? settings.conditionFactor.limited
      : rec.grade.state === 'graded' || rec.conditionEvidence === 'adequate' ? settings.conditionFactor.adequate
      : settings.conditionFactor.limited;
    const recency = recencyWeight(a.ageDays, settings.recencyHalfLifeDays);
    const quality = settings.recordQualityFactor[rec.recordQuality];
    a.pool = pool;
    a.factors = { recency, condition: conditionFactor, recordQuality: quality };
    a.weight = recency * conditionFactor * quality;
  }

  const summarize = (pool: Pool): PoolSummary => {
    const items = assess.filter((a) => a.pool === pool);
    if (items.length === 0) return emptyPool();
    const values = items.map((a) => ({ value: a.normalizedMinor!, weight: a.weight! }));
    const n = items.length;
    const clusters = new Set(items.map((a) => a.correlationClusterId)).size;
    let band: PoolSummary['band'] = null;
    const lo = Math.min(...values.map((v) => v.value));
    const hi = Math.max(...values.map((v) => v.value));
    if (clusters >= settings.strong.minEvents) {
      band = {
        kind: 'recent_comparable_sales_band_p20_p80',
        lowMinor: weightedQuantile(values, settings.bandQuantiles[0]),
        highMinor: weightedQuantile(values, settings.bandQuantiles[1]),
      };
    } else if (n >= 3) band = { kind: 'observed_range', lowMinor: lo, highMinor: hi };
    else if (n === 2) band = { kind: 'limited_range', lowMinor: lo, highMinor: hi };
    return {
      eventCount: n,
      independentEventCount: clusters,
      effectiveSampleSize: effectiveSampleSize(values.map((v) => v.weight)),
      weightedMedianMinor: n >= 3 ? weightedMedian(values) : null,
      unweightedMedianMinor: median(values.map((v) => v.value)),
      band,
      logDispersion: robustLogDispersion(values.map((v) => v.value)),
      evidenceIds: items.map((a) => a.evidenceId),
    };
  };

  // Outlier flags (never exclusions).
  let outlierImpact: string | null = null;
  for (const pool of ['precise', 'broad'] as Pool[]) {
    const items = assess.filter((a) => a.pool === pool);
    if (items.length < settings.outlierMinSample) continue;
    const zs = robustLogZ(items.map((a) => a.normalizedMinor!));
    items.forEach((a, i) => {
      a.robustZ = zs[i] ?? null;
      if (a.robustZ != null && Math.abs(a.robustZ) > settings.outlierRobustZ) {
        a.flags.push(`Statistical outlier flag (robust z ${a.robustZ.toFixed(2)}): retained; investigate variant, damage, bundle, fees or payment issues.`);
      }
    });
  }

  const precise = summarize('precise');
  const broad = summarize('broad');

  const flagged = assess.filter((a) => a.pool === 'precise' && a.robustZ != null && Math.abs(a.robustZ) > settings.outlierRobustZ);
  if (flagged.length > 0 && precise.weightedMedianMinor != null) {
    const rest = assess.filter((a) => a.pool === 'precise' && !flagged.includes(a));
    if (rest.length > 0) {
      const alt = weightedMedian(rest.map((a) => ({ value: a.normalizedMinor!, weight: a.weight! })));
      outlierImpact = `${flagged.length} flagged extreme record(s) retained. Without them the weighted median would be ${(alt / 100).toFixed(2)} vs ${(precise.weightedMedianMinor / 100).toFixed(2)} ${input.currency}.`;
      flags.push(outlierImpact);
    }
  }
  const volatility = precise.eventCount >= 3 && precise.logDispersion > settings.volatilityLogDispersion;
  if (volatility) flags.push(`High price dispersion among direct comps (robust log dispersion ${precise.logDispersion.toFixed(2)}).`);
  const relistInPool = assess.some((a) => a.pool === 'precise' && a.flags.some((f) => f.startsWith('Shares ')));
  if (relistInPool) flags.push('Some direct comps share a certification/serial number with nearby events (possible relists); review.');
  const correlated = precise.eventCount > precise.independentEventCount;
  if (correlated) flags.push(`${precise.eventCount - precise.independentEventCount} direct comp(s) are resales of the same physical card (correlated evidence).`);

  const poolRecs = precise.evidenceIds.map((id) => recById.get(id)!);
  const containsOwnerSupplied = poolRecs.some((r) => r.acquisitionMethod === 'owner_supplied');
  const containsFixture = ordered.some((r) => r.isFixture);
  if (containsFixture) flags.unshift('FIXTURE DATA PRESENT — results are for demonstration and testing only, not a market valuation.');
  if (containsOwnerSupplied) flags.push('Direct comps include owner-supplied evidence that has not been independently verified.');

  const subjectConditionAssessable =
    input.subject.grade.state === 'graded' ||
    (input.subject.rawConditionBand != null && input.subject.rawConditionBand !== 'not_assessable');
  const adequateShare = poolRecs.length ? poolRecs.filter((r) => r.grade.state === 'graded' || r.conditionEvidence === 'adequate').length / poolRecs.length : 0;

  // Market-evidence strength (§8.5) — provisional release gates.
  const events = precise.independentEventCount;
  let strength: Strength;
  if (precise.eventCount === 0) strength = 'insufficient';
  else if (precise.eventCount <= 2) strength = 'limited';
  else if (
    events >= settings.strong.minEvents &&
    precise.effectiveSampleSize >= settings.strong.minEffectiveSample &&
    input.gates.identityResolved &&
    subjectConditionAssessable &&
    adequateShare >= 0.5 &&
    !volatility &&
    flagged.length === 0 &&
    !relistInPool &&
    !containsOwnerSupplied &&
    !containsFixture
  ) strength = 'strong';
  else if (events >= settings.moderate.minEvents && precise.effectiveSampleSize >= settings.moderate.minEffectiveSample && !volatility) strength = 'moderate';
  else strength = 'limited';

  // Headline (§8.4 steps 6–9, §5 suppression).
  const disp = (m: number | null, s: Strength) => (m == null ? null : displayRoundMinor(m, s === 'insufficient' ? 'limited' : s));
  let headline: Headline;
  const mk = (kind: Headline['kind'], central: number | null, low: number | null, high: number | null, statement: string, scenario: string | null = null): Headline => ({
    kind, centralMinor: central, lowMinor: low, highMinor: high,
    display: { central: disp(central, strength), low: disp(low, strength), high: disp(high, strength) },
    statement, scenario,
  });

  if (!input.gates.identityResolved) {
    headline = mk('suppressed', null, null, null, `No value shown: material identity is unresolved (${input.gates.identityIssues.join('; ') || 'confirm identity'}).`);
  } else if (precise.eventCount === 0 && broad.eventCount === 0) {
    headline = mk('insufficient', null, null, null, 'Insufficient direct sales evidence.');
  } else if (precise.eventCount === 0) {
    headline = mk('broad_indication_only', null, broad.band?.lowMinor ?? null, broad.band?.highMinor ?? null,
      `Insufficient condition-matched sales evidence. A broader raw-card market indication from ${broad.eventCount} sale(s) without adequate condition matching is shown separately; it is not a condition-matched estimate.`);
  } else if (precise.eventCount <= 2) {
    headline = mk('limited', null, precise.band?.lowMinor ?? poolRecsMin(precise, assess), precise.band?.highMinor ?? poolRecsMin(precise, assess),
      `Limited evidence: ${precise.eventCount} direct sale(s). Records shown without a stable market estimate.`);
  } else if (events < settings.strong.minEvents) {
    headline = mk('tentative', precise.weightedMedianMinor, precise.band!.lowMinor, precise.band!.highMinor,
      `Tentative median from ${precise.eventCount} direct sales (observed low–high shown). A small observed range does not bound the next sale.`);
  } else {
    headline = mk('estimate', precise.weightedMedianMinor, precise.band!.lowMinor, precise.band!.highMinor,
      `Weighted median of ${precise.eventCount} direct sales with a recent comparable-sales band (weighted 20th–80th percentile). This band is not a prediction or confidence interval.`);
  }

  let reportState: ValuationResult['reportState'] = strength === 'strong' || strength === 'moderate' ? 'ready' : 'limited_evidence';
  if (input.gates.authenticity === 'unresolved_material' && (headline.centralMinor != null || headline.lowMinor != null)) {
    if (input.gates.conditionalScenario && precise.eventCount >= 3) {
      headline = { ...headline, kind: 'conditional', scenario: input.gates.conditionalScenario,
        statement: `Conditional estimate — valid only if: ${input.gates.conditionalScenario}. Unresolved: ${input.gates.authenticityIssues.join('; ')}.` };
    } else {
      headline = mk('suppressed', null, null, null, `No unconditional value shown: authenticity/record status is materially unresolved (${input.gates.authenticityIssues.join('; ')}).`);
    }
    reportState = 'conditional';
  } else if (input.gates.authenticity === 'unresolved_material') {
    headline = { ...headline, statement: `${headline.statement} Authenticity is also unresolved (${input.gates.authenticityIssues.join('; ')}).` };
    reportState = 'conditional';
  }

  // Scenario (Tier B) groups — never part of the direct pool.
  const scenarioMap = new Map<string, RecordAssessment[]>();
  for (const a of assess) {
    if (a.tier !== 'B' || a.basisGroup !== 'headline') continue;
    const blocking = a.exclusions.filter((e) => e !== 'outside_window');
    if (blocking.length) continue;
    const key = a.gradeLabel + (recById.get(a.evidenceId)!.rawConditionBand ? ` / ${recById.get(a.evidenceId)!.rawConditionBand}` : '');
    if (!scenarioMap.has(key)) scenarioMap.set(key, []);
    scenarioMap.get(key)!.push(a);
  }
  const scenarioGroups: ScenarioGroup[] = [...scenarioMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, xs]) => {
    const v = xs.map((x) => x.normalizedMinor!);
    return { label, count: xs.length, medianMinor: xs.length >= 3 ? median(v) : null, lowMinor: Math.min(...v), highMinor: Math.max(...v), evidenceIds: xs.map((x) => x.evidenceId) };
  });

  const basisMap = new Map<BasisGroup, string[]>();
  for (const a of assess) {
    if (a.basisGroup === 'headline') continue;
    if (!basisMap.has(a.basisGroup)) basisMap.set(a.basisGroup, []);
    basisMap.get(a.basisGroup)!.push(a.evidenceId);
  }

  for (const a of assess) a.exclusionText = a.exclusions.map((e) => EXCLUSION_TEXT[e]);

  return {
    calcVersion: settings.calcVersion,
    settings,
    valuationDate: input.valuationDate,
    currency: input.currency,
    priceBasis: HEADLINE_BASIS_LABEL,
    subjectGrade: describeGrade(input.subject.grade),
    window: { selectedDays, expansions, olderThanMaxCount: olderThanMax },
    records: assess,
    precise,
    broad,
    strength,
    headline,
    confidence: {
      identity: input.gates.identityResolved ? 'Identity confirmed for valuation' : `Unresolved: ${input.gates.identityIssues.join('; ')}`,
      conditionVisibility: input.subject.grade.state === 'graded'
        ? 'Graded holder; card condition per grader label (slab not physically verified)'
        : subjectConditionAssessable ? `Photo-based band: ${input.subject.rawConditionBand} (not a professional grade)` : 'Not assessable from photos',
      authenticity: input.gates.authenticity === 'unresolved_material' ? `Unresolved: ${input.gates.authenticityIssues.join('; ')}` : input.gates.authenticity === 'resolved' ? 'No material unresolved authenticity question' : 'Not material to this valuation',
      marketEvidence: strength,
    },
    flags,
    scenarioGroups,
    analogEvidenceIds: assess.filter((a) => a.tier === 'C').map((a) => a.evidenceId),
    separateBasisGroups: [...basisMap.entries()].map(([group, evidenceIds]) => ({ group, evidenceIds })),
    guideBenchmarks: input.guideBenchmarks ?? [],
    duplicateGroups: dd.groups.filter((g) => g.memberEvidenceIds.length > 1),
    retrievalTruncated,
    containsFixtureData: containsFixture,
    containsOwnerSuppliedEvidence: containsOwnerSupplied,
    outlierImpact,
    reportState,
  };
}

function poolRecsMin(p: PoolSummary, assess: RecordAssessment[]): number | null {
  const v = assess.filter((a) => p.evidenceIds.includes(a.evidenceId)).map((a) => a.normalizedMinor!);
  return v.length ? v[0]! : null;
}
