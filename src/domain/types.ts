/**
 * Core domain types. These mirror the specification's identification schema
 * (section 4), the comparable-sales ingestion contract (section 7) and the
 * report/state contract (section 9).
 */

export const CATEGORIES = ['baseball', 'football', 'basketball', 'hockey', 'pokemon'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Field provenance status — spec §4. */
export const FIELD_STATUSES = [
  'observed',
  'catalog_matched',
  'owner_reported',
  'provider_verified',
  'inferred',
  'conflicting',
  'unknown',
] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

/** Statuses the model itself may assign. Anything stronger is set only by application code. */
export const MODEL_ASSIGNABLE_STATUSES: readonly FieldStatus[] = ['observed', 'inferred', 'conflicting', 'unknown'];

export const IDENTITY_FIELD_NAMES = [
  // All categories
  'category', 'subject', 'team', 'manufacturer', 'brand', 'product_line', 'set_name', 'subset',
  'release_year', 'copyright_year', 'card_number', 'language', 'region', 'edition', 'insert',
  'parallel', 'foil_treatment', 'artwork_variation', 'serial_numerator', 'serial_denominator',
  'promo_stamp', 'reprint_status', 'error_variation', 'visible_text', 'catalog_ids', 'reference_urls',
  // Sports
  'rookie_designation', 'rookie_designation_source', 'prospect_designation', 'first_card_designation',
  'licensed_status', 'autograph_presence', 'autograph_type', 'inscription', 'signer_count',
  'manufacturer_autograph_statement', 'relic_type', 'relic_count', 'relic_claim_class',
  'patch_colors_observed', 'relic_wording',
  // Pokémon
  'set_symbol_code', 'rarity', 'first_edition_mark', 'shadowless', 'holo_treatment', 'texture',
  // Slab
  'is_slabbed', 'grading_company', 'label_text', 'card_grade', 'autograph_grade', 'subgrades',
  'qualifiers', 'label_designation', 'cert_number', 'slab_damage',
] as const;
export type IdentityFieldName = (typeof IDENTITY_FIELD_NAMES)[number];

export interface IdentityField {
  /** Always a string (or null) — card and serial numbers must keep leading zeroes and slashes. */
  value: string | null;
  status: FieldStatus;
  /** Evidence reference: an asset/region/observation id or a short locator such as "front:bottom-left". */
  evidence: string | null;
  uncertainty: string | null;
}

export type IdentityFields = Partial<Record<IdentityFieldName, IdentityField>>;

export const RELIC_CLAIM_CLASSES = [
  'game_used', 'player_worn', 'event_worn', 'manufactured',
  'not_associated_with_specific_player_or_event', 'unknown',
] as const;

export const AUTOGRAPH_TYPES = [
  'none', 'printed_facsimile', 'manufacturer_certified_on_card', 'manufacturer_certified_sticker',
  'aftermarket', 'third_party_authenticated', 'unknown',
] as const;

export const GRADERS = ['PSA', 'BGS', 'SGC', 'CGC', 'other'] as const;
export type Grader = (typeof GRADERS)[number];

/**
 * Fields that define *which card* this is for comp matching (§8.1 Tier A).
 * A disagreement on any of these makes a sale a different card.
 */
export const MATERIAL_MATCH_FIELDS: readonly IdentityFieldName[] = [
  'category', 'subject', 'set_name', 'subset', 'release_year', 'card_number', 'language', 'edition',
  'insert', 'parallel', 'foil_treatment', 'serial_denominator', 'promo_stamp', 'reprint_status',
  'autograph_type', 'relic_claim_class', 'first_edition_mark', 'shadowless', 'artwork_variation',
  'error_variation',
];

/** Simplified identity used to describe a sale's mapped card. */
export type MatchIdentity = Partial<Record<IdentityFieldName, string | null>>;

export interface GradeInfo {
  /** 'raw' or 'graded' */
  state: 'raw' | 'graded';
  grader: Grader | null;
  /** Card grade string as printed (e.g. "10", "9.5", "AUTHENTIC"). Null = card not graded (e.g. auto-only slab). */
  cardGrade: string | null;
  autographGrade: string | null;
  qualifiers: string[];
}

/** Broad photo-based condition band (§5) — never a professional grade. */
export const CONDITION_BANDS = [
  'appears_well_preserved', 'minor_wear_visible', 'moderate_wear_visible', 'heavy_wear_or_damage', 'not_assessable',
] as const;
export type ConditionBand = (typeof CONDITION_BANDS)[number];

// ---------------------------------------------------------------------------
// Sales evidence (§7)
// ---------------------------------------------------------------------------

export type DataPurpose = 'catalog_reference' | 'certification' | 'individual_sale' | 'aggregate_price_guide' | 'active_ask';

export type ReportedSaleStatus = 'sold' | 'completed_unsold' | 'active' | 'unknown';
export type SaleFormat = 'auction' | 'fixed_price' | 'best_offer' | 'marketplace_auction' | 'private' | 'unknown';

/**
 * How the reported amount relates to what the buyer paid.
 * - item_price: item price excl. shipping/tax at a venue that charges no buyer premium
 * - hammer: auction hammer only (premium excluded)
 * - hammer_plus_premium: buyer premium already included
 * - total_including_shipping: includes shipping (and possibly tax)
 * - unknown
 */
export type PriceBasis = 'item_price' | 'hammer' | 'hammer_plus_premium' | 'total_including_shipping' | 'unknown';

export interface SaleRecordInput {
  // provenance
  provider: string;
  originMarketplace: string;
  sourceRecordId: string | null;
  canonicalUrl: string | null;
  acquisitionMethod: 'licensed_api' | 'licensed_feed' | 'owner_supplied' | 'fixture';
  retrievedAt: string; // ISO
  snapshotHash: string | null;
  evidenceExcerpt: string | null;
  isFixture: boolean;

  // event
  saleDate: string; // ISO date or datetime
  saleDatePrecision: 'day' | 'datetime' | 'month';
  saleStatus: ReportedSaleStatus;
  paymentStatus: 'paid' | 'unpaid' | 'unknown';
  canceled: boolean;
  returned: boolean;
  relisted: boolean;
  saleFormat: SaleFormat;
  quantity: number;
  isLot: boolean;
  lotAllocationTrusted: boolean;

  // identity
  originalTitle: string;
  mappedIdentity: MatchIdentity;
  identityEvidenceNote: string | null;
  grade: GradeInfo;
  conditionEvidence: 'adequate' | 'limited' | 'insufficient';
  rawConditionBand: ConditionBand | null;
  serialNumber: string | null;
  certNumber: string | null;
  alteredOrReproduction: boolean;

  // money (integer minor units)
  currency: string;
  reportedAmountMinor: number | null;
  priceBasis: PriceBasis;
  buyerPremiumMinor: number | null;
  buyerPremiumRate: number | null; // e.g. 0.20, only if evidenced for this specific sale
  buyerPremiumEvidence: string | null;
  shippingMinor: number | null;
  taxMinor: number | null;
  acceptedOffer: boolean;
  acceptedAmountKnown: boolean;
  /** Feed record quality: original record visible vs. permitted feed with complete fields but weaker visibility. */
  recordQuality: 'original_record' | 'feed_complete_fields';
}

export interface SaleRecord extends SaleRecordInput {
  evidenceId: string;
}

// ---------------------------------------------------------------------------
// Analysis state (§9)
// ---------------------------------------------------------------------------

export const ANALYSIS_STATES = [
  'needs_photos', 'needs_identification', 'needs_answers', 'retrieving_sales', 'ready',
  'limited_evidence', 'conditional', 'failed_retryable',
] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number] | 'analyzing';

export type CertCheckStatus = 'record_matches' | 'record_mismatch' | 'record_not_found' | 'lookup_unavailable' | 'not_checked';
