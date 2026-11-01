/**
 * FIXTURE provider — synthetic sales for development and demos ONLY.
 * Enabled solely when ALLOW_FIXTURES=true and NODE_ENV !== 'production'.
 * Every record is flagged isFixture=true, uses the reserved `.invalid`
 * domain, and every report containing one carries an unmistakable banner.
 */
import crypto from 'node:crypto';
import type { SaleRecordInput } from '../domain/types.js';
import type { Provider, SalesQuery } from './types.js';

function rng(seed: string) {
  let h = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h / 0xffffffff;
  };
}

export function createFixtureProvider(enabled: boolean): Provider {
  return {
    descriptor: {
      id: 'fixture', name: 'FIXTURE synthetic sales (not real data)', purposes: ['individual_sale'],
      categories: ['baseball', 'football', 'basketball', 'hockey', 'pokemon'], contentType: 'transaction',
      accessMechanism: 'Built-in generator', accessFinding: 'Synthetic test data. Never a market source.', sourceRefs: [],
      rights: { allowedUses: 'Testing only', attribution: 'FIXTURE', retentionDays: null, displayAllowed: true, exportAllowed: true, refreshLimit: null, territory: null, currencies: ['USD'] },
      acceptedOfferSupport: 'yes', cancellationHandling: 'Simulated',
    },
    status: () => (enabled ? 'connected' : 'not_configured'),
    statusDetail: () => (enabled ? 'FIXTURE MODE — synthetic records are labeled everywhere.' : 'Disabled (ALLOW_FIXTURES not set, or production).'),
    async searchSales(q: SalesQuery) {
      if (!enabled) throw new Error('fixture provider disabled');
      const r = rng(`${q.identityVersionId}`);
      const base = 2000 + Math.floor(r() * 30000);
      const now = Date.now();
      const records: SaleRecordInput[] = [];
      const mk = (i: number, over: Partial<SaleRecordInput>): SaleRecordInput => {
        const ageDays = Math.floor(r() * 170);
        const amt = Math.round(base * (0.8 + r() * 0.4));
        return {
          provider: 'fixture', originMarketplace: 'fixture-market', sourceRecordId: `fx-${q.identityVersionId.slice(0, 8)}-${i}`,
          canonicalUrl: `https://fixture.invalid/sale/${q.identityVersionId.slice(0, 8)}/${i}`, acquisitionMethod: 'fixture',
          retrievedAt: new Date().toISOString(), snapshotHash: null, evidenceExcerpt: 'FIXTURE', isFixture: true,
          saleDate: new Date(now - ageDays * 86_400_000).toISOString().slice(0, 10), saleDatePrecision: 'day', saleStatus: 'sold',
          paymentStatus: 'unknown', canceled: false, returned: false, relisted: false, saleFormat: 'fixed_price', quantity: 1, isLot: false,
          lotAllocationTrusted: false, originalTitle: `[FIXTURE] ${q.identity.release_year ?? ''} ${q.identity.set_name ?? ''} ${q.identity.subject ?? ''} #${q.identity.card_number ?? '?'}`.trim(),
          mappedIdentity: { ...q.identity }, identityEvidenceNote: 'Synthetic identity copied from query', grade: { ...q.grade },
          conditionEvidence: 'adequate', rawConditionBand: q.grade.state === 'raw' ? 'appears_well_preserved' : null, serialNumber: null, certNumber: null,
          alteredOrReproduction: false, currency: 'USD', reportedAmountMinor: amt, priceBasis: 'item_price', buyerPremiumMinor: null,
          buyerPremiumRate: null, buyerPremiumEvidence: null, shippingMinor: null, taxMinor: null, acceptedOffer: false, acceptedAmountKnown: false,
          recordQuality: 'original_record', ...over,
        };
      };
      for (let i = 0; i < 9; i++) records.push(mk(i, {}));
      // A mirrored duplicate of record 0 from a second "aggregator".
      records.push({ ...records[0]!, provider: 'fixture', recordQuality: 'feed_complete_fields', canonicalUrl: records[0]!.canonicalUrl + '?utm_source=agg' });
      records.push(mk(20, { saleStatus: 'completed_unsold' }));
      records.push(mk(21, { acceptedOffer: true, acceptedAmountKnown: false, saleFormat: 'best_offer' }));
      records.push(mk(22, { mappedIdentity: { ...q.identity, parallel: 'Gold (different parallel)' } }));
      records.push(mk(23, { saleFormat: 'auction', priceBasis: 'hammer' }));
      records.push(mk(24, { isLot: true, quantity: 3 }));
      return { records, truncated: false, nextCursor: null, queryDescription: `FIXTURE search for identity ${q.identityVersionId}` };
    },
  };
}
