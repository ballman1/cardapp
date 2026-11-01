/**
 * Comp matching tiers and hard exclusions (§8.1).
 *
 * Tier A — direct comps: same card on every material field and comparable
 *          condition / identical grader+grade+qualifiers.
 * Tier B — scenario evidence: same card, different condition/grade.
 * Tier C — contextual analogs: different parallel/grader/etc. Context only.
 */
import {
  MATERIAL_MATCH_FIELDS,
  type ConditionBand,
  type GradeInfo,
  type IdentityFieldName,
  type MatchIdentity,
  type SaleRecord,
} from '../domain/types.js';

export type Tier = 'A' | 'B' | 'C';

export type ExclusionReason =
  | 'not_reported_sold'
  | 'active_ask'
  | 'completed_unsold'
  | 'hidden_accepted_offer'
  | 'canceled_or_returned'
  | 'mixed_lot_without_allocation'
  | 'altered_or_reproduction'
  | 'unidentified_material_variant'
  | 'different_card'
  | 'duplicate'
  | 'price_basis_unresolved'
  | 'outside_window'
  | 'insufficient_condition_evidence'
  | 'user_flagged'
  | 'truncated';

export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  not_reported_sold: 'Record does not explicitly report a sale.',
  active_ask: 'Active asking price, not a sale.',
  completed_unsold: 'Completed listing that did not sell.',
  hidden_accepted_offer: 'Accepted offer with undisclosed accepted amount; the list price is not the sale price.',
  canceled_or_returned: 'Transaction known to be canceled or returned.',
  mixed_lot_without_allocation: 'Multi-card lot without a trustworthy per-card allocation.',
  altered_or_reproduction: 'Altered, reproduction or reprint item; not comparable to an unaltered original.',
  unidentified_material_variant: 'A material identity attribute could not be established for this sale.',
  different_card: 'Sale is for a different card.',
  duplicate: 'Duplicate of another record for the same sale event (mirror retained as evidence path).',
  price_basis_unresolved: 'Price basis could not be reconciled to the headline basis; shown in a separate basis group.',
  outside_window: 'Outside the selected search window.',
  insufficient_condition_evidence: 'Raw-card condition evidence inadequate for a condition-matched comp; used only in the broader raw indication.',
  user_flagged: 'Flagged by the owner as a mistake (logged; pending review).',
  truncated: 'Beyond the retrieval cap.',
};

export interface SubjectCard {
  identity: MatchIdentity;
  grade: GradeInfo;
  /** Photo-based condition band of the subject when raw. */
  rawConditionBand: ConditionBand | null;
}

export interface Classification {
  tier: Tier | null;
  exclusions: ExclusionReason[];
  /** Human-readable explanation of the tier decision / mismatched fields. */
  notes: string[];
  mismatchedFields: IdentityFieldName[];
  /** For raw comps: whether this record can enter the precise condition-matched pool. */
  rawPool: 'precise' | 'broad' | null;
}

const norm = (v: string | null | undefined): string | null => {
  if (v == null) return null;
  const t = v.trim().toLowerCase().replace(/\s+/g, ' ');
  return t === '' || t === 'unknown' ? null : t;
};

/** Sale-status and transaction-shape exclusions, independent of identity. */
export function transactionExclusions(rec: SaleRecord): ExclusionReason[] {
  const out: ExclusionReason[] = [];
  if (rec.saleStatus === 'active') out.push('active_ask');
  else if (rec.saleStatus === 'completed_unsold') out.push('completed_unsold');
  else if (rec.saleStatus !== 'sold') out.push('not_reported_sold');
  if (rec.acceptedOffer && !rec.acceptedAmountKnown) out.push('hidden_accepted_offer');
  if (rec.canceled || rec.returned) out.push('canceled_or_returned');
  if ((rec.isLot || rec.quantity > 1) && !rec.lotAllocationTrusted) out.push('mixed_lot_without_allocation');
  if (rec.alteredOrReproduction) out.push('altered_or_reproduction');
  return out;
}

function gradeKey(g: GradeInfo): string {
  if (g.state === 'raw') return 'raw';
  return [g.grader ?? '?', norm(g.cardGrade) ?? '-', norm(g.autographGrade) ?? '-', [...g.qualifiers].map((q) => q.toLowerCase()).sort().join('+')].join('|');
}

export function classify(subject: SubjectCard, rec: SaleRecord): Classification {
  const exclusions = transactionExclusions(rec);
  const notes: string[] = [];
  const mismatched: IdentityFieldName[] = [];
  let unidentified = false;

  for (const f of MATERIAL_MATCH_FIELDS) {
    const s = norm(subject.identity[f]);
    const r = norm(rec.mappedIdentity[f]);
    if (s == null && r == null) continue;
    if (s != null && r == null) {
      unidentified = true;
      notes.push(`Sale does not establish ${f} (subject: "${subject.identity[f]}").`);
      continue;
    }
    if (s == null && r != null) {
      // The subject's own attribute is unresolved; the sale cannot be a confirmed direct match.
      unidentified = true;
      notes.push(`Subject ${f} unresolved; sale states "${rec.mappedIdentity[f]}".`);
      continue;
    }
    if (s !== r) {
      mismatched.push(f);
      notes.push(`${f}: subject "${subject.identity[f]}" vs sale "${rec.mappedIdentity[f]}".`);
    }
  }

  let tier: Tier | null;
  let rawPool: Classification['rawPool'] = null;

  if (mismatched.length > 0) {
    // Different parallel / language / edition etc. → analog context at most.
    const coreSame = ['subject', 'set_name', 'card_number', 'category'].every(
      (f) => norm(subject.identity[f as IdentityFieldName]) === norm(rec.mappedIdentity[f as IdentityFieldName]),
    );
    tier = coreSame || mismatched.length <= 2 ? 'C' : null;
    if (tier === null) exclusions.push('different_card');
  } else if (unidentified) {
    tier = null;
    exclusions.push('unidentified_material_variant');
  } else {
    // Same card. Now condition / grade.
    const sk = gradeKey(subject.grade);
    const rk = gradeKey(rec.grade);
    if (subject.grade.state === 'graded' && rec.grade.state === 'graded') {
      if (subject.grade.grader !== rec.grade.grader) {
        tier = 'C';
        notes.push(`Different grading company (${rec.grade.grader} vs ${subject.grade.grader}); grader scales are not interchangeable.`);
      } else if (sk === rk) {
        tier = 'A';
      } else {
        tier = 'B';
        notes.push(`Same card, different grade/qualifier (${describeGrade(rec.grade)} vs ${describeGrade(subject.grade)}).`);
      }
    } else if (subject.grade.state !== rec.grade.state) {
      tier = 'B';
      notes.push(`Same card, ${rec.grade.state} sale vs ${subject.grade.state} subject — scenario evidence only.`);
    } else {
      // both raw
      if (rec.conditionEvidence === 'insufficient' || subject.rawConditionBand == null || subject.rawConditionBand === 'not_assessable') {
        tier = 'A';
        rawPool = 'broad';
        notes.push(
          subject.rawConditionBand == null || subject.rawConditionBand === 'not_assessable'
            ? 'Subject raw condition not assessable from photos; record used only for the broader raw-card indication.'
            : 'Sale lacks adequate condition evidence (seller terms like "mint" are not verified condition); broader raw indication only.',
        );
      } else if (rec.rawConditionBand && rec.rawConditionBand !== subject.rawConditionBand) {
        tier = 'B';
        notes.push(`Same card, different apparent raw condition (${rec.rawConditionBand} vs ${subject.rawConditionBand}).`);
      } else if (!rec.rawConditionBand) {
        tier = 'A';
        rawPool = 'broad';
        notes.push('Sale condition band not established; broader raw indication only.');
      } else {
        tier = 'A';
        rawPool = 'precise';
      }
    }
  }
  return { tier, exclusions, notes, mismatchedFields: mismatched, rawPool };
}

export function describeGrade(g: GradeInfo): string {
  if (g.state === 'raw') return 'raw';
  const parts = [g.grader ?? 'unknown grader'];
  parts.push(g.cardGrade ? `card ${g.cardGrade}` : 'card not graded');
  if (g.autographGrade) parts.push(`auto ${g.autographGrade}`);
  if (g.qualifiers.length) parts.push(g.qualifiers.join(', '));
  return parts.join(' ');
}
