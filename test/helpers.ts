import type { MatchIdentity, SaleRecord } from '../src/domain/types.js';
import type { SubjectCard } from '../src/valuation/eligibility.js';
import type { FxLookup } from '../src/valuation/normalize.js';
import type { ValuationGates } from '../src/valuation/engine.js';

export const BASE_ID: MatchIdentity = {
  category: 'basketball',
  subject: 'Test Player',
  set_name: 'Prizm',
  release_year: '2019-20',
  card_number: '248',
  language: 'English',
  parallel: 'Silver',
  autograph_type: 'none',
};

export const rawSubject = (band: SubjectCard['rawConditionBand'] = 'appears_well_preserved'): SubjectCard => ({
  identity: { ...BASE_ID },
  grade: { state: 'raw', grader: null, cardGrade: null, autographGrade: null, qualifiers: [] },
  rawConditionBand: band,
});

export const gradedSubject = (grader: 'PSA' | 'BGS' = 'PSA', cardGrade: string | null = '10', autographGrade: string | null = null): SubjectCard => ({
  identity: { ...BASE_ID },
  grade: { state: 'graded', grader, cardGrade, autographGrade, qualifiers: [] },
  rawConditionBand: null,
});

let n = 0;
export function sale(over: Partial<SaleRecord> = {}): SaleRecord {
  n++;
  return {
    evidenceId: `ev_${String(n).padStart(4, '0')}`,
    provider: 'test',
    originMarketplace: 'ebay',
    sourceRecordId: `item${n}`,
    canonicalUrl: `https://www.example.com/itm/${n}`,
    acquisitionMethod: 'licensed_api',
    retrievedAt: '2026-11-01T00:00:00Z',
    snapshotHash: null,
    evidenceExcerpt: null,
    isFixture: false,
    saleDate: '2026-10-01',
    saleDatePrecision: 'day',
    saleStatus: 'sold',
    paymentStatus: 'paid',
    canceled: false,
    returned: false,
    relisted: false,
    saleFormat: 'fixed_price',
    quantity: 1,
    isLot: false,
    lotAllocationTrusted: false,
    originalTitle: '2019-20 Prizm Test Player #248 Silver',
    mappedIdentity: { ...BASE_ID },
    identityEvidenceNote: null,
    grade: { state: 'graded', grader: 'PSA', cardGrade: '10', autographGrade: null, qualifiers: [] },
    conditionEvidence: 'adequate',
    rawConditionBand: null,
    serialNumber: null,
    certNumber: null,
    alteredOrReproduction: false,
    currency: 'USD',
    reportedAmountMinor: 10000,
    priceBasis: 'item_price',
    buyerPremiumMinor: null,
    buyerPremiumRate: null,
    buyerPremiumEvidence: null,
    shippingMinor: null,
    taxMinor: null,
    acceptedOffer: false,
    acceptedAmountKnown: false,
    recordQuality: 'original_record',
    ...over,
  };
}

export const noFx: FxLookup = () => null;
export const okGates: ValuationGates = { identityResolved: true, identityIssues: [], authenticity: 'not_material', authenticityIssues: [], conditionalScenario: null };
export const VDATE = '2026-11-01T00:00:00Z';
