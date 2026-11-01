/**
 * Provider adapter contracts (§6). Each provider declares what it is for,
 * what its license allows, and its live connection status. Only `connected`
 * providers are ever searched.
 */
import type { Category, CertCheckStatus, DataPurpose, GradeInfo, MatchIdentity, SaleRecordInput } from '../domain/types.js';

export const CONNECTOR_STATUSES = ['not_configured', 'awaiting_access', 'connected', 'rate_limited', 'temporarily_unavailable', 'unsupported'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export interface ProviderRights {
  allowedUses: string;
  attribution: string | null;
  /** Days we may retain records; null = unknown → treat as session-only until confirmed. */
  retentionDays: number | null;
  displayAllowed: boolean;
  exportAllowed: boolean;
  refreshLimit: string | null;
  territory: string | null;
  currencies: string[] | null;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  purposes: DataPurpose[];
  categories: Category[];
  contentType: 'transaction' | 'aggregate' | 'certification' | 'catalog' | 'mixed';
  accessMechanism: string;
  accessFinding: string;
  sourceRefs: string[];
  rights: ProviderRights;
  acceptedOfferSupport: 'yes' | 'no' | 'unknown';
  cancellationHandling: string;
}

export interface SalesQuery {
  identityVersionId: string;
  identity: MatchIdentity;
  grade: GradeInfo;
  category: Category | null;
  windowDays: number;
  maxResults: number;
  cursor: string | null;
  cardId: string;
  userId: string;
}

export interface SalesSearchResult {
  records: SaleRecordInput[];
  truncated: boolean;
  nextCursor: string | null;
  queryDescription: string;
}

export interface CertResult {
  status: CertCheckStatus;
  returned: Record<string, unknown> | null;
  mismatches: { field: string; label: string | null; record: string | null }[];
  error: string | null;
}

export interface GuideResult {
  label: string;
  valueMinor: number;
  currency: string;
  asOf: string;
  note: string;
}

export interface Provider {
  descriptor: ProviderDescriptor;
  status(): ConnectorStatus;
  statusDetail(): string;
  searchSales?(q: SalesQuery): Promise<SalesSearchResult>;
  verifyCertificate?(grader: string, certNumber: string, label: { year?: string | null; subject?: string | null; cardNumber?: string | null; cardGrade?: string | null }): Promise<CertResult>;
  getGuideBenchmark?(q: SalesQuery): Promise<GuideResult | null>;
}

export class ProviderError extends Error {
  constructor(public kind: 'rate_limited' | 'access_denied' | 'unavailable' | 'malformed' | 'timeout', message: string) {
    super(message);
  }
}
