/**
 * Identity assembly and gating. Converts validated model output into
 * provenance-tagged fields, applies owner corrections without erasing the AI
 * suggestion, and decides whether identity/authenticity are resolved enough
 * for an unconditional value.
 */
import type { Extraction } from '../ai/schemas.js';
import {
  IDENTITY_FIELD_NAMES,
  MATERIAL_MATCH_FIELDS,
  MODEL_ASSIGNABLE_STATUSES,
  type CertCheckStatus,
  type ConditionBand,
  type GradeInfo,
  type Grader,
  type IdentityField,
  type IdentityFieldName,
  type IdentityFields,
  type MatchIdentity,
} from './types.js';

export function fieldsFromExtraction(x: Extraction): { fields: IdentityFields; notes: string[] } {
  const fields: IdentityFields = {};
  const notes: string[] = [];
  for (const f of x.fields) {
    let status = f.status;
    if (!MODEL_ASSIGNABLE_STATUSES.includes(status)) {
      notes.push(`Model status ${status} for ${f.name} downgraded to inferred.`);
      status = 'inferred';
    }
    const value = f.value == null ? null : String(f.value).trim() || null;
    const prev = fields[f.name];
    if (prev && prev.value !== value) {
      fields[f.name] = { value: null, status: 'conflicting', evidence: [prev.evidence, f.evidence].filter(Boolean).join(' | ') || null, uncertainty: `Model returned conflicting values: "${prev.value}" vs "${value}".` };
      continue;
    }
    fields[f.name] = { value: status === 'unknown' ? null : value, status: value == null && status !== 'conflicting' ? 'unknown' : status, evidence: f.evidence, uncertainty: f.uncertainty };
  }
  if (x.category && !fields.category?.value) fields.category = { value: x.category, status: 'inferred', evidence: 'overall card design', uncertainty: null };
  // A serial "numerator/denominator" printed as a collector number is not a serial — nothing to do automatically, but flag odd shapes.
  const sd = fields.serial_denominator?.value;
  if (sd && !/^\d+$/.test(sd)) notes.push(`serial_denominator "${sd}" is not numeric; review.`);
  return { fields, notes };
}

export interface FieldCorrection {
  name: IdentityFieldName;
  value: string | null;
}

/** Owner corrections become owner_reported fields; the prior value is kept in the diff. */
export function applyCorrections(fields: IdentityFields, corrections: FieldCorrection[]): { fields: IdentityFields; diff: { name: string; from: IdentityField | null; to: IdentityField }[] } {
  const out: IdentityFields = structuredClone(fields);
  const diff: { name: string; from: IdentityField | null; to: IdentityField }[] = [];
  for (const c of corrections) {
    if (!IDENTITY_FIELD_NAMES.includes(c.name)) continue;
    const value = c.value == null ? null : String(c.value).trim().slice(0, 500) || null;
    const prev = out[c.name] ?? null;
    if (prev && prev.value === value && prev.status !== 'conflicting') continue;
    const to: IdentityField = { value, status: value == null ? 'unknown' : 'owner_reported', evidence: 'owner correction', uncertainty: null };
    out[c.name] = to;
    diff.push({ name: c.name, from: prev, to });
  }
  return { fields: out, diff };
}

export function matchIdentity(fields: IdentityFields): MatchIdentity {
  const m: MatchIdentity = {};
  for (const [k, f] of Object.entries(fields) as [IdentityFieldName, IdentityField][]) {
    if (f && f.value != null && f.status !== 'conflicting' && f.status !== 'unknown') m[k] = f.value;
  }
  return m;
}

const GRADERS: Grader[] = ['PSA', 'BGS', 'SGC', 'CGC'];

export function gradeInfo(fields: IdentityFields, rawOrGradedHint: string | null): GradeInfo {
  const slabbed = /^(true|yes)$/i.test(fields.is_slabbed?.value ?? '') || rawOrGradedHint === 'graded';
  if (!slabbed) return { state: 'raw', grader: null, cardGrade: null, autographGrade: null, qualifiers: [] };
  const g = (fields.grading_company?.value ?? '').toUpperCase().trim();
  const grader: Grader | null = GRADERS.find((x) => g.startsWith(x)) ?? (g ? 'other' : null);
  const quals = (fields.qualifiers?.value ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return { state: 'graded', grader, cardGrade: fields.card_grade?.value ?? null, autographGrade: fields.autograph_grade?.value ?? null, qualifiers: quals };
}

const CORE_FIELDS: IdentityFieldName[] = ['category', 'subject', 'set_name', 'card_number'];

export function identityGate(fields: IdentityFields, confirmed: boolean, candidates: unknown[]): { resolved: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!confirmed) issues.push('identity not yet confirmed by the owner');
  for (const f of CORE_FIELDS) if (!fields[f]?.value) issues.push(`${f} unknown`);
  for (const f of MATERIAL_MATCH_FIELDS) if (fields[f]?.status === 'conflicting') issues.push(`${f} conflicting`);
  if (!confirmed && candidates.length > 1) issues.push(`${candidates.length} candidate variants remain`);
  return { resolved: issues.length === 0, issues };
}

export interface AuthenticityGate {
  authenticity: 'resolved' | 'not_material' | 'unresolved_material';
  issues: string[];
  scenario: string | null;
  autographStatus: string;
  relicStatus: string;
}

export function authenticityGate(fields: IdentityFields, extraction: Extraction | null, cert: { status: CertCheckStatus; mismatches: unknown[] } | null): AuthenticityGate {
  const issues: string[] = [];
  const autoPresent = /^(yes|true|present)/i.test(fields.autograph_presence?.value ?? '');
  const autoType = fields.autograph_type?.value ?? null;
  let autographStatus = 'No autograph observed';
  if (autoPresent) {
    if (autoType === 'manufacturer_certified_on_card' || autoType === 'manufacturer_certified_sticker') {
      autographStatus = `Autograph observed; manufacturer certification statement ${fields.manufacturer_autograph_statement?.value ? 'present' : 'not transcribed'} (${fields.autograph_type?.status}). Physical authenticity not verified.`;
      if (!fields.manufacturer_autograph_statement?.value) issues.push('autograph observed but manufacturer certification statement not established');
    } else if (autoType === 'third_party_authenticated') {
      autographStatus = 'Autograph observed; third-party authentication claimed — verify the authenticator record.';
      if (fields.autograph_type?.status !== 'provider_verified') issues.push('third-party autograph authentication not verified');
    } else if (autoType === 'printed_facsimile') {
      autographStatus = 'Printed/facsimile signature (part of the card design).';
    } else {
      autographStatus = 'Autograph-like marking observed; authentication unknown. No authenticated-autograph premium assumed.';
      issues.push('autograph authenticity unknown');
    }
  }
  const relic = fields.relic_claim_class?.value ?? null;
  const relicStatus = fields.relic_type?.value
    ? `Relic present (${fields.relic_type.value}); claim class: ${relic ?? 'unknown'}${fields.relic_wording?.value ? ` — wording: "${fields.relic_wording.value}"` : ' — manufacturer wording not established'}.`
    : 'No relic observed';
  if (cert) {
    if (cert.status === 'record_mismatch') issues.push('certification record does not match the photographed label/card');
    if (cert.status === 'record_not_found') issues.push('certification number not found by the grader lookup');
  }
  for (const n of extraction?.authenticity_notes ?? []) if (n.material) issues.push(`${n.topic}: ${n.note}`);
  const authenticity = issues.length ? 'unresolved_material' : autoPresent || fields.relic_type?.value || cert ? 'resolved' : 'not_material';
  return { authenticity, issues, scenario: null, autographStatus, relicStatus };
}

export function conditionBand(x: Extraction | null): ConditionBand | null {
  return x?.condition_band ?? null;
}

/** Human-readable one-liner. */
export function identityLabel(fields: IdentityFields): string {
  const v = (n: IdentityFieldName) => fields[n]?.value;
  return [v('release_year'), v('manufacturer') ?? v('brand'), v('set_name'), v('subject'), v('card_number') ? `#${v('card_number')}` : null, v('parallel'), v('language') && v('language') !== 'English' ? v('language') : null, v('edition')]
    .filter(Boolean)
    .join(' ') || 'Unidentified card';
}
