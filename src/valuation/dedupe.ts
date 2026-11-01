/**
 * Cross-source deduplication (§7 Deduplication).
 *
 * 1. Same origin marketplace + item/lot id → same event.
 * 2. Same normalized URL → same event.
 * 3. No ids: same day + same serial/cert + same amount/currency → same event.
 *
 * A later genuine resale of the same certified card is a distinct event,
 * retained and placed in a correlation cluster. Closely timed records that
 * share a cert/serial but different ids are flagged as possible relists.
 */
import type { SaleRecord } from '../domain/types.js';

export interface DuplicateGroup {
  groupId: string;
  primaryEvidenceId: string;
  memberEvidenceIds: string[];
  reasons: string[];
}

export interface DedupeResult {
  groups: DuplicateGroup[];
  /** evidenceId → groupId */
  groupOf: Map<string, string>;
  /** Correlation clusters of distinct events sharing a cert/serial. groupId → clusterId */
  clusterOf: Map<string, string>;
  /** groupIds flagged as possible relist (close in time to another event for the same item). */
  relistFlags: Map<string, string>;
}

export function normalizeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    url.hash = '';
    const keep = new URLSearchParams();
    // Drop tracking params; keep params that commonly identify an item.
    for (const [k, v] of url.searchParams) {
      if (/^(utm_|_trk|mkevt|mkcid|campid|customid|toolid|hash)/i.test(k)) continue;
      keep.append(k, v);
    }
    const qs = keep.toString();
    return `${url.protocol}//${url.host.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${qs ? `?${qs}` : ''}`;
  } catch {
    return u.trim().toLowerCase();
  }
}

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let p = this.parent.get(x)!;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra);
  }
}

const day = (iso: string) => iso.slice(0, 10);
const daysBetween = (a: string, b: string) => Math.abs(Date.parse(day(a)) - Date.parse(day(b))) / 86_400_000;

/** Record preference for choosing the primary of a group: original records over feeds, then earliest retrieval. */
function rank(r: SaleRecord): number {
  return (r.recordQuality === 'original_record' ? 0 : 10) + (r.acquisitionMethod === 'owner_supplied' ? 5 : 0);
}

export function dedupe(records: SaleRecord[], relistWindowDays = 30): DedupeResult {
  const uf = new UnionFind();
  const reasons = new Map<string, Set<string>>();
  const addReason = (id: string, r: string) => {
    if (!reasons.has(id)) reasons.set(id, new Set());
    reasons.get(id)!.add(r);
  };
  const byKey = (keyFn: (r: SaleRecord) => string | null, label: string) => {
    const seen = new Map<string, string>();
    for (const r of records) {
      uf.find(r.evidenceId);
      const k = keyFn(r);
      if (!k) continue;
      const prev = seen.get(k);
      if (prev) {
        uf.union(prev, r.evidenceId);
        addReason(prev, label);
        addReason(r.evidenceId, label);
      } else seen.set(k, r.evidenceId);
    }
  };

  byKey((r) => (r.sourceRecordId ? `${r.originMarketplace.toLowerCase()}::${r.sourceRecordId}` : null), 'same marketplace item/lot id');
  byKey((r) => normalizeUrl(r.canonicalUrl), 'same normalized URL');
  byKey((r) => {
    if (r.sourceRecordId) return null;
    const ident = r.certNumber || r.serialNumber;
    if (!ident || r.reportedAmountMinor == null) return null;
    return `${day(r.saleDate)}::${ident}::${r.reportedAmountMinor}::${r.currency}`;
  }, 'same date, cert/serial and amount');

  const members = new Map<string, SaleRecord[]>();
  for (const r of records) {
    const g = uf.find(r.evidenceId);
    if (!members.has(g)) members.set(g, []);
    members.get(g)!.push(r);
  }

  const groups: DuplicateGroup[] = [];
  const groupOf = new Map<string, string>();
  for (const [gid, rs] of [...members.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...rs].sort((a, b) => rank(a) - rank(b) || (a.evidenceId < b.evidenceId ? -1 : 1));
    const rsn = new Set<string>();
    for (const r of rs) for (const x of reasons.get(r.evidenceId) ?? []) rsn.add(x);
    groups.push({ groupId: gid, primaryEvidenceId: sorted[0]!.evidenceId, memberEvidenceIds: sorted.map((r) => r.evidenceId), reasons: [...rsn] });
    for (const r of rs) groupOf.set(r.evidenceId, gid);
  }

  // Correlation clusters over distinct events sharing cert/serial.
  const clusterUf = new UnionFind();
  const identSeen = new Map<string, { gid: string; date: string }[]>();
  const relistFlags = new Map<string, string>();
  for (const g of groups) {
    clusterUf.find(g.groupId);
    const primary = records.find((r) => r.evidenceId === g.primaryEvidenceId)!;
    const ident = primary.certNumber
      ? `cert:${primary.grade.grader ?? '?'}:${primary.certNumber}`
      : primary.serialNumber
        ? `serial:${primary.serialNumber.replace(/\s+/g, '')}`
        : null;
    if (!ident) continue;
    const prev = identSeen.get(ident) ?? [];
    for (const p of prev) {
      clusterUf.union(p.gid, g.groupId);
      if (daysBetween(p.date, primary.saleDate) <= relistWindowDays) {
        const msg = `Shares ${ident} with another event within ${relistWindowDays} days — possible relist or non-payment; review.`;
        relistFlags.set(g.groupId, msg);
        relistFlags.set(p.gid, msg);
      }
    }
    prev.push({ gid: g.groupId, date: primary.saleDate });
    identSeen.set(ident, prev);
  }
  const clusterOf = new Map<string, string>();
  for (const g of groups) clusterOf.set(g.groupId, clusterUf.find(g.groupId));
  return { groups, groupOf, clusterOf, relistFlags };
}
