/**
 * Provider registry: the allowlist of providers the application may call.
 * The model cannot add providers or change their status.
 */
import type { Config } from '../config.js';
import { THIRD_PARTY_CATALOG } from './catalog.js';
import { createFixtureProvider } from './fixture.js';
import { createPsaProvider } from './psa.js';
import type { ConnectorStatus, Provider } from './types.js';

/** Owner-supplied evidence: comps the owner enters with a source link. Searched from the card's own records. */
export const ownerSuppliedProvider: Provider = {
  descriptor: {
    id: 'owner_supplied', name: 'Owner-supplied evidence', purposes: ['individual_sale'],
    categories: ['baseball', 'football', 'basketball', 'hockey', 'pokemon'], contentType: 'transaction',
    accessMechanism: 'Entered by the card owner with a link to the original sale',
    accessFinding: 'Owner assertions; labeled as not independently verified and never upgraded to verified evidence.',
    sourceRefs: [],
    rights: { allowedUses: "Owner's own report", attribution: 'Owner-supplied', retentionDays: null, displayAllowed: true, exportAllowed: true, refreshLimit: null, territory: null, currencies: null },
    acceptedOfferSupport: 'yes', cancellationHandling: 'Owner-reported',
  },
  status: () => 'connected',
  statusDetail: () => 'Always available; records are labeled owner-supplied.',
};

function catalogProvider(entry: (typeof THIRD_PARTY_CATALOG)[number]): Provider {
  const { defaultStatus, ...descriptor } = entry;
  return {
    descriptor,
    status: () => defaultStatus as ConnectorStatus,
    statusDetail: () => descriptor.accessFinding,
  };
}

export interface Registry {
  all(): Provider[];
  get(id: string): Provider | undefined;
  connectedSalesProviders(): Provider[];
  certProviderFor(grader: string): Provider | undefined;
}

export function createRegistry(cfg: Config, extra: Provider[] = []): Registry {
  const providers: Provider[] = [
    ownerSuppliedProvider,
    createPsaProvider({ apiToken: cfg.psa.apiToken, baseUrl: cfg.psa.baseUrl }),
    ...THIRD_PARTY_CATALOG.map(catalogProvider),
    ...(cfg.allowFixtures ? [createFixtureProvider(true)] : []),
    ...extra,
  ];
  const byId = new Map(providers.map((p) => [p.descriptor.id, p]));
  return {
    all: () => providers,
    get: (id) => byId.get(id),
    connectedSalesProviders: () => providers.filter((p) => p.status() === 'connected' && typeof p.searchSales === 'function'),
    certProviderFor: (grader) => (grader === 'PSA' ? byId.get('psa_cert') : undefined),
  };
}
