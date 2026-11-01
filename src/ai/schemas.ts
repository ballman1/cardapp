/**
 * Versioned strict output schemas for model stages (§10, §14).
 * JSON Schema (for the Responses API strict structured output) and a
 * matching zod validator (we never trust the wire format blindly).
 */
import { z } from 'zod';
import { CATEGORIES, CONDITION_BANDS, IDENTITY_FIELD_NAMES } from '../domain/types.js';

export const EXTRACTION_SCHEMA_VERSION = 'extraction-schema-2026.11.01';
export const EXPLANATION_SCHEMA_VERSION = 'explanation-schema-2026.11.01';

const nullableString = { type: ['string', 'null'] } as const;
const bbox = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['x', 'y', 'w', 'h'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
} as const;

export const IMAGE_ISSUES = ['blur', 'glare', 'cropped_corners', 'perspective', 'low_resolution', 'obstruction', 'sleeve_reflection', 'slab_reflection', 'too_dark', 'filter_or_editing_suspected', 'not_a_card'] as const;
export const REGION_LABELS = ['card_number', 'set_mark', 'serial_stamp', 'grading_label', 'autograph', 'relic', 'suspected_defect', 'copyright_line', 'promo_stamp', 'rarity_symbol'] as const;
export const CONDITION_ASPECTS = ['corners', 'edges', 'surface', 'centering', 'crease', 'dent', 'stain', 'whitening', 'print_line', 'scratch', 'scuffing', 'fading', 'discoloration', 'registration', 'suspected_alteration'] as const;

export const extractionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['images_show_single_card', 'multiple_cards_detected', 'front_back_consistency', 'image_quality_issues', 'category', 'fields', 'candidates', 'regions', 'condition_observations', 'centering', 'condition_band', 'condition_band_rationale', 'authenticity_notes', 'questions', 'requested_photos'],
  properties: {
    images_show_single_card: { type: 'boolean' },
    multiple_cards_detected: { type: 'boolean' },
    front_back_consistency: { type: 'string', enum: ['consistent', 'inconsistent', 'uncertain', 'back_missing'] },
    image_quality_issues: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['image', 'issue', 'detail'], properties: { image: { type: 'string', enum: ['front', 'back'] }, issue: { type: 'string', enum: IMAGE_ISSUES }, detail: { type: 'string' } } },
    },
    category: { type: ['string', 'null'], enum: [...CATEGORIES, null] },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value', 'status', 'evidence', 'uncertainty'],
        properties: {
          name: { type: 'string', enum: IDENTITY_FIELD_NAMES },
          value: nullableString,
          status: { type: 'string', enum: ['observed', 'inferred', 'conflicting', 'unknown'] },
          evidence: nullableString,
          uncertainty: nullableString,
        },
      },
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'distinguishing_attribute', 'differences'],
        properties: {
          label: { type: 'string' },
          distinguishing_attribute: { type: 'string' },
          differences: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'value'], properties: { name: { type: 'string', enum: IDENTITY_FIELD_NAMES }, value: nullableString } } },
        },
      },
    },
    regions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['label', 'image', 'bbox', 'note'], properties: { label: { type: 'string', enum: REGION_LABELS }, image: { type: 'string', enum: ['front', 'back'] }, bbox, note: { type: 'string' } } },
    },
    condition_observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['aspect', 'image', 'status', 'severity', 'bbox', 'bbox_reliable', 'attributed_to', 'explanation'],
        properties: {
          aspect: { type: 'string', enum: CONDITION_ASPECTS },
          image: { type: 'string', enum: ['front', 'back'] },
          status: { type: 'string', enum: ['visible', 'not_observed', 'not_assessable'] },
          severity: { type: ['string', 'null'], enum: ['minor', 'moderate', 'major', null] },
          bbox,
          bbox_reliable: { type: 'boolean' },
          attributed_to: { type: 'string', enum: ['card', 'slab', 'sleeve', 'unknown'] },
          explanation: { type: 'string' },
        },
      },
    },
    centering: {
      type: 'object',
      additionalProperties: false,
      required: ['measurable', 'front_left_right', 'front_top_bottom', 'back_left_right', 'back_top_bottom', 'method_note'],
      properties: { measurable: { type: 'boolean' }, front_left_right: nullableString, front_top_bottom: nullableString, back_left_right: nullableString, back_top_bottom: nullableString, method_note: { type: 'string' } },
    },
    condition_band: { type: 'string', enum: CONDITION_BANDS },
    condition_band_rationale: { type: 'string' },
    authenticity_notes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['topic', 'note', 'material'], properties: { topic: { type: 'string', enum: ['autograph', 'relic', 'slab', 'reprint_or_counterfeit', 'alteration', 'serial'] }, note: { type: 'string' }, material: { type: 'boolean' } } },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'field', 'text', 'reason', 'options'],
        properties: { code: { type: 'string' }, field: { type: ['string', 'null'], enum: [...IDENTITY_FIELD_NAMES, null] }, text: { type: 'string' }, reason: { type: 'string', enum: ['identity', 'authenticity', 'condition', 'comp_eligibility'] }, options: { type: 'array', items: { type: 'string' } } },
      },
    },
    requested_photos: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['region', 'lighting', 'why'], properties: { region: { type: 'string' }, lighting: { type: 'string', enum: ['diffuse', 'angled', 'raking', 'macro'] }, why: { type: 'string' } } },
    },
  },
} as const;

const BBox = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).nullable();

export const ExtractionZ = z.object({
  images_show_single_card: z.boolean(),
  multiple_cards_detected: z.boolean(),
  front_back_consistency: z.enum(['consistent', 'inconsistent', 'uncertain', 'back_missing']),
  image_quality_issues: z.array(z.object({ image: z.enum(['front', 'back']), issue: z.enum(IMAGE_ISSUES), detail: z.string() })),
  category: z.enum(CATEGORIES).nullable(),
  fields: z.array(z.object({ name: z.enum(IDENTITY_FIELD_NAMES), value: z.string().max(2000).nullable(), status: z.enum(['observed', 'inferred', 'conflicting', 'unknown']), evidence: z.string().max(500).nullable(), uncertainty: z.string().max(500).nullable() })).max(200),
  candidates: z.array(z.object({ label: z.string(), distinguishing_attribute: z.string(), differences: z.array(z.object({ name: z.enum(IDENTITY_FIELD_NAMES), value: z.string().nullable() })) })).max(10),
  regions: z.array(z.object({ label: z.enum(REGION_LABELS), image: z.enum(['front', 'back']), bbox: BBox, note: z.string() })).max(30),
  condition_observations: z.array(z.object({ aspect: z.enum(CONDITION_ASPECTS), image: z.enum(['front', 'back']), status: z.enum(['visible', 'not_observed', 'not_assessable']), severity: z.enum(['minor', 'moderate', 'major']).nullable(), bbox: BBox, bbox_reliable: z.boolean(), attributed_to: z.enum(['card', 'slab', 'sleeve', 'unknown']), explanation: z.string() })).max(80),
  centering: z.object({ measurable: z.boolean(), front_left_right: z.string().nullable(), front_top_bottom: z.string().nullable(), back_left_right: z.string().nullable(), back_top_bottom: z.string().nullable(), method_note: z.string() }),
  condition_band: z.enum(CONDITION_BANDS),
  condition_band_rationale: z.string(),
  authenticity_notes: z.array(z.object({ topic: z.enum(['autograph', 'relic', 'slab', 'reprint_or_counterfeit', 'alteration', 'serial']), note: z.string(), material: z.boolean() })),
  questions: z.array(z.object({ code: z.string().max(64), field: z.enum(IDENTITY_FIELD_NAMES).nullable(), text: z.string().max(400), reason: z.enum(['identity', 'authenticity', 'condition', 'comp_eligibility']), options: z.array(z.string().max(120)).max(8) })).max(12),
  requested_photos: z.array(z.object({ region: z.string(), lighting: z.enum(['diffuse', 'angled', 'raking', 'macro']), why: z.string() })).max(6),
});
export type Extraction = z.infer<typeof ExtractionZ>;

export const explanationJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'points', 'next_best_action'],
  properties: {
    summary: { type: 'string' },
    points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'evidence_ids'], properties: { text: { type: 'string' }, evidence_ids: { type: 'array', items: { type: 'string' } } } } },
    next_best_action: { type: 'string' },
  },
} as const;

export const ExplanationZ = z.object({
  summary: z.string().max(2000),
  points: z.array(z.object({ text: z.string().max(1000), evidence_ids: z.array(z.string()) })).max(12),
  next_best_action: z.string().max(600),
});
export type Explanation = z.infer<typeof ExplanationZ>;
