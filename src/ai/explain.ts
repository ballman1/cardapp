/**
 * Explanation stage guardrails (§10): the model receives the frozen result and
 * may not introduce numbers or cite evidence IDs that were not supplied.
 * When validation fails or the model is unavailable, a deterministic
 * explanation is used and the reason is recorded.
 */
import type { ValuationResult } from '../valuation/engine.js';
import type { Explanation } from './schemas.js';

export const fmtMoney = (minor: number | null, currency: string) =>
  minor == null ? null : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);

/** Compact frozen view handed to the model (display-rounded values only). */
export function frozenView(r: ValuationResult, identityLabel: string, certStatus: string, sourcesSearched: string[]) {
  const h = r.headline;
  return {
    card: identityLabel,
    subject_grade: r.subjectGrade,
    currency: r.currency,
    price_basis: r.priceBasis,
    headline_kind: h.kind,
    statement: h.statement,
    display: { central: fmtMoney(h.display.central, r.currency), low: fmtMoney(h.display.low, r.currency), high: fmtMoney(h.display.high, r.currency) },
    direct_comp_count: r.precise.eventCount,
    independent_events: r.precise.independentEventCount,
    effective_sample_size: Number(r.precise.effectiveSampleSize.toFixed(1)),
    window_days: r.window.selectedDays,
    market_evidence_strength: r.strength,
    confidence: r.confidence,
    flags: r.flags,
    scenario_groups: r.scenarioGroups.map((g) => ({ label: g.label, count: g.count })),
    analog_count: r.analogEvidenceIds.length,
    certificate_status: certStatus,
    sources_searched: sourcesSearched,
    retrieval_truncated: r.retrievalTruncated,
    fixture_data: r.containsFixtureData,
  };
}

const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

export function validateExplanation(e: Explanation, frozen: unknown, allowedIds: string[]): string[] {
  const problems: string[] = [];
  const allowed = new Set(allowedIds);
  for (const p of e.points) for (const id of p.evidence_ids) if (!allowed.has(id)) problems.push(`unknown evidence id ${id}`);
  const frozenText = JSON.stringify(frozen);
  const allowedNums = new Set((frozenText.match(NUM_RE) ?? []).map((s) => s.replace(/,/g, '')));
  const text = [e.summary, ...e.points.map((p) => p.text), e.next_best_action].join(' ');
  for (const raw of text.match(NUM_RE) ?? []) {
    const n = raw.replace(/,/g, '').replace(/\.$/, '');
    if (n.length <= 1) continue; // single digits ("1 sale", "2 photos") are low-risk
    if (!allowedNums.has(n)) problems.push(`number ${raw} not present in frozen result`);
  }
  return problems;
}

export function deterministicExplanation(r: ValuationResult, nextAction: string): Explanation {
  const h = r.headline;
  const pts: Explanation['points'] = [];
  if (r.precise.eventCount > 0) {
    pts.push({ text: `${r.precise.eventCount} direct comparable sale(s) in the last ${r.window.selectedDays} days (effective sample size ${r.precise.effectiveSampleSize.toFixed(1)}).`, evidence_ids: r.precise.evidenceIds.slice(0, 20) });
  }
  if (r.broad.eventCount > 0) pts.push({ text: `${r.broad.eventCount} raw sale(s) without adequate condition matching form a separate broader indication.`, evidence_ids: r.broad.evidenceIds.slice(0, 20) });
  if (r.scenarioGroups.length) pts.push({ text: `Same card in other grades/conditions is shown as scenario evidence only: ${r.scenarioGroups.map((g) => `${g.label} (${g.count})`).join('; ')}.`, evidence_ids: r.scenarioGroups.flatMap((g) => g.evidenceIds).slice(0, 20) });
  if (r.analogEvidenceIds.length) pts.push({ text: `${r.analogEvidenceIds.length} related-card record(s) are context only and do not affect the estimate.`, evidence_ids: r.analogEvidenceIds.slice(0, 20) });
  for (const f of r.flags) pts.push({ text: f, evidence_ids: [] });
  return { summary: `${h.statement} Market evidence: ${r.strength}.`, points: pts, next_best_action: nextAction };
}

export function nextBestAction(r: ValuationResult, ctx: { certStatus: string; requestedPhotos: string[]; identityIssues: string[]; authenticityIssues: string[] }): string {
  if (ctx.identityIssues.length) return `Resolve identity: ${ctx.identityIssues[0]}.`;
  if (ctx.authenticityIssues.length) return `Resolve authenticity: ${ctx.authenticityIssues[0]} (in-person or third-party authentication may be required).`;
  if (ctx.certStatus === 'lookup_unavailable' || ctx.certStatus === 'not_checked') {
    if (r.subjectGrade !== 'raw') return 'Verify the certification number with the grading company.';
  }
  if (ctx.requestedPhotos.length) return `Add a photo: ${ctx.requestedPhotos[0]}.`;
  if (r.strength === 'insufficient' || r.strength === 'limited') return 'Add more permitted sales evidence (e.g., owner-supplied sold records with links), or connect a licensed sales source.';
  return 'Revalue periodically; prices change with demand.';
}
