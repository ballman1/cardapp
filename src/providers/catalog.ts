/**
 * Provider catalog — encodes the source-access findings from spec §6
 * (researched 2026-11-01). None of the third-party commercial sources are
 * enabled by default: each needs a confirmed, permitted access route.
 */
import type { ProviderDescriptor } from './types.js';
import { CATEGORIES } from '../domain/types.js';

const ALL = [...CATEGORIES];
const SPORTS = ALL.filter((c) => c !== 'pokemon');
const unknownRights = {
  allowedUses: 'Not established — agreement required before enabling.',
  attribution: null,
  retentionDays: null,
  displayAllowed: false,
  exportAllowed: false,
  refreshLimit: null,
  territory: null,
  currencies: null,
};

export type CatalogEntry = ProviderDescriptor & { defaultStatus: 'not_configured' | 'awaiting_access' | 'unsupported' };

export const THIRD_PARTY_CATALOG: CatalogEntry[] = [
  {
    id: 'ebay_marketplace_insights', name: 'eBay sold records (Marketplace Insights)', purposes: ['individual_sale'], categories: ALL,
    contentType: 'transaction', accessMechanism: 'Restricted Buy API (Marketplace Insights) under an authorized arrangement',
    accessFinding: 'eBay documents Marketplace Insights as restricted and not open to new users. A developer account does not grant sold-history access. The consumer Price Guide is not an integration license.',
    sourceRefs: ['https://developer.ebay.com/api-docs/buy/static/ref-marketplace-supported.html', 'https://pages.ebay.com/price-guide/'],
    rights: unknownRights, acceptedOfferSupport: 'unknown', cancellationHandling: 'Unknown until access is granted.', defaultStatus: 'awaiting_access',
  },
  {
    id: '130point', name: '130point', purposes: ['individual_sale'], categories: ALL, contentType: 'transaction',
    accessMechanism: 'None permitted without written permission',
    accessFinding: 'Indexed terms prohibit automated use and restrict commercial/competing uses; direct terms page returned 403 during research. Unavailable for automatic ingestion.',
    sourceRefs: ['https://130point.com/terms'], rights: unknownRights, acceptedOfferSupport: 'unknown', cancellationHandling: 'Unknown.', defaultStatus: 'unsupported',
  },
  {
    id: 'sportscardspro', name: 'SportsCardsPro', purposes: ['catalog_reference', 'aggregate_price_guide'], categories: SPORTS, contentType: 'aggregate',
    accessMechanism: 'Subscription API / CSV', accessFinding: 'Current values only — no historical sales. Can provide a guide benchmark and catalog help, never transaction comps. Confirm commercial display/retention rights.',
    sourceRefs: ['https://www.sportscardspro.com/api-documentation'], rights: unknownRights, acceptedOfferSupport: 'no', cancellationHandling: 'N/A (aggregate).', defaultStatus: 'not_configured',
  },
  {
    id: 'pricecharting', name: 'PriceCharting', purposes: ['catalog_reference', 'aggregate_price_guide'], categories: ['pokemon'], contentType: 'aggregate',
    accessMechanism: 'Subscription API', accessFinding: 'Current values rather than historical transactions. Guide estimates must stay separate from individual comps; verify coverage and rights.',
    sourceRefs: ['https://www.pricecharting.com/api-documentation'], rights: unknownRights, acceptedOfferSupport: 'no', cancellationHandling: 'N/A (aggregate).', defaultStatus: 'not_configured',
  },
  {
    id: 'tcgplayer', name: 'TCGplayer', purposes: ['catalog_reference', 'aggregate_price_guide'], categories: ['pokemon'], contentType: 'aggregate',
    accessMechanism: 'Existing permitted API access or a licensed vendor', accessFinding: 'Official docs state new API access is not being granted. Market-price aggregates are not individual sale records.',
    sourceRefs: ['https://docs.tcgplayer.com/docs/getting-started'], rights: unknownRights, acceptedOfferSupport: 'no', cancellationHandling: 'N/A.', defaultStatus: 'awaiting_access',
  },
  {
    id: 'heritage', name: 'Heritage Auctions archive', purposes: ['individual_sale'], categories: ALL, contentType: 'transaction',
    accessMechanism: 'Separately confirmed permitted route required', accessFinding: 'Archive has descriptions, images, pedigrees and results; automated ingestion, retention and republication need a confirmed agreement.',
    sourceRefs: ['https://sports.ha.com/c/ref/information-archive.zx'], rights: unknownRights, acceptedOfferSupport: 'no', cancellationHandling: 'Unknown.', defaultStatus: 'not_configured',
  },
  {
    id: 'fanatics_collect', name: 'Fanatics Collect', purposes: ['individual_sale'], categories: ALL, contentType: 'transaction',
    accessMechanism: 'Candidate — agreement required', accessFinding: 'API availability and commercial rights not verified.', sourceRefs: [], rights: unknownRights,
    acceptedOfferSupport: 'unknown', cancellationHandling: 'Unknown.', defaultStatus: 'not_configured',
  },
  {
    id: 'goldin', name: 'Goldin', purposes: ['individual_sale'], categories: ALL, contentType: 'transaction',
    accessMechanism: 'Candidate — agreement required', accessFinding: 'API availability and commercial rights not verified.', sourceRefs: [], rights: unknownRights,
    acceptedOfferSupport: 'unknown', cancellationHandling: 'Unknown.', defaultStatus: 'not_configured',
  },
  {
    id: 'rea', name: 'Robert Edward Auctions', purposes: ['individual_sale'], categories: SPORTS, contentType: 'transaction',
    accessMechanism: 'Candidate — agreement required', accessFinding: 'API availability and commercial rights not verified.', sourceRefs: [], rights: unknownRights,
    acceptedOfferSupport: 'no', cancellationHandling: 'Unknown.', defaultStatus: 'not_configured',
  },
  {
    id: 'card_ladder', name: 'Card Ladder', purposes: ['individual_sale', 'aggregate_price_guide'], categories: ALL, contentType: 'mixed',
    accessMechanism: 'Candidate licensed feed', accessFinding: 'A consumer subscription does not grant API or redistribution rights. Evaluate transaction coverage, settlement status, accepted-offer handling, provenance and duplication before contracting.',
    sourceRefs: [], rights: unknownRights, acceptedOfferSupport: 'unknown', cancellationHandling: 'Unknown.', defaultStatus: 'not_configured',
  },
  {
    id: 'market_movers', name: 'Market Movers', purposes: ['individual_sale', 'aggregate_price_guide'], categories: ALL, contentType: 'mixed',
    accessMechanism: 'Candidate licensed feed', accessFinding: 'A consumer subscription does not grant API or redistribution rights.', sourceRefs: [], rights: unknownRights,
    acceptedOfferSupport: 'unknown', cancellationHandling: 'Unknown.', defaultStatus: 'not_configured',
  },
];
