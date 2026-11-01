/**
 * PSA certificate lookup (§4 Slab-specific, §6). Uses the PSA Public API with a
 * bearer token the operator obtains from PSA. The path below follows PSA's
 * public API documentation (https://www.psacard.com/publicapi/documentation);
 * confirm it against the current docs during Phase 0 — base URL is configurable.
 *
 * A matching record only means the label details agree with PSA's database.
 * It does not authenticate the physical holder.
 */
import type { CertResult, ConnectorStatus, Provider } from './types.js';
import { ProviderError } from './types.js';

const norm = (s: unknown) => (s == null ? null : String(s).trim().toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim() || null);

export function createPsaProvider(opts: { apiToken: string | null; baseUrl: string; fetchImpl?: typeof fetch }): Provider {
  const f = opts.fetchImpl ?? fetch;
  let runtime: ConnectorStatus | null = null;
  let detail = '';
  return {
    descriptor: {
      id: 'psa_cert',
      name: 'PSA certificate verification',
      purposes: ['certification'],
      categories: ['baseball', 'football', 'basketball', 'hockey', 'pokemon'],
      contentType: 'certification',
      accessMechanism: 'PSA Public API, authenticated bearer token',
      accessFinding: 'Public API documentation supports authenticated certificate lookup. Certificate access does not imply a bulk sold-history or population-data license.',
      sourceRefs: ['https://www.psacard.com/publicapi/documentation'],
      rights: {
        allowedUses: 'Per-card certificate verification for the owner. Confirm display/retention terms with PSA.',
        attribution: 'Certificate data: PSA', retentionDays: null, displayAllowed: true, exportAllowed: false,
        refreshLimit: 'PSA API rate limits apply', territory: null, currencies: null,
      },
      acceptedOfferSupport: 'no',
      cancellationHandling: 'N/A',
    },
    status() {
      if (!opts.apiToken) return 'not_configured';
      return runtime ?? 'connected';
    },
    statusDetail() {
      return opts.apiToken ? detail || 'Token configured.' : 'Set PSA_API_TOKEN to enable certificate lookups.';
    },
    async verifyCertificate(grader, certNumber, label): Promise<CertResult> {
      if (grader !== 'PSA') return { status: 'not_checked', returned: null, mismatches: [], error: `No connected verification service for ${grader}.` };
      if (!opts.apiToken) return { status: 'lookup_unavailable', returned: null, mismatches: [], error: 'PSA lookup not configured.' };
      if (!/^\d{5,12}$/.test(certNumber)) return { status: 'not_checked', returned: null, mismatches: [], error: 'Certificate number not in an expected numeric format; confirm it.' };
      let res: Response;
      try {
        res = await f(`${opts.baseUrl}/cert/GetByCertNumber/${encodeURIComponent(certNumber)}`, {
          headers: { authorization: `bearer ${opts.apiToken}`, accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        runtime = 'temporarily_unavailable';
        detail = `Network error: ${(e as Error).message}`;
        return { status: 'lookup_unavailable', returned: null, mismatches: [], error: detail };
      }
      if (res.status === 429) {
        runtime = 'rate_limited';
        detail = 'PSA rate limit reached.';
        throw new ProviderError('rate_limited', detail);
      }
      if (res.status === 401 || res.status === 403) {
        runtime = 'awaiting_access';
        detail = `PSA denied access (HTTP ${res.status}).`;
        return { status: 'lookup_unavailable', returned: null, mismatches: [], error: detail };
      }
      if (res.status === 404) return { status: 'record_not_found', returned: null, mismatches: [], error: null };
      if (!res.ok) {
        runtime = 'temporarily_unavailable';
        detail = `PSA HTTP ${res.status}`;
        return { status: 'lookup_unavailable', returned: null, mismatches: [], error: detail };
      }
      runtime = 'connected';
      detail = '';
      let body: any;
      try {
        body = await res.json();
      } catch {
        return { status: 'lookup_unavailable', returned: null, mismatches: [], error: 'Malformed PSA response.' };
      }
      const cert = body?.PSACert;
      if (!cert || typeof cert !== 'object') return { status: 'record_not_found', returned: body ?? null, mismatches: [], error: null };
      const returned: Record<string, unknown> = {
        certNumber: cert.CertNumber, year: cert.Year, brand: cert.Brand, category: cert.Category, cardNumber: cert.CardNumber,
        subject: cert.Subject, variety: cert.Variety, cardGrade: cert.CardGrade, gradeDescription: cert.GradeDescription,
      };
      const mismatches: CertResult['mismatches'] = [];
      const cmp = (field: string, labelVal: string | null | undefined, recVal: unknown, loose = false) => {
        const a = norm(labelVal);
        const b = norm(recVal);
        if (!a || !b) return;
        if (loose ? !(a.includes(b) || b.includes(a)) : a !== b) mismatches.push({ field, label: labelVal ?? null, record: recVal == null ? null : String(recVal) });
      };
      cmp('card_number', label.cardNumber, cert.CardNumber);
      cmp('subject', label.subject, cert.Subject, true);
      cmp('release_year', label.year, cert.Year, true);
      cmp('card_grade', label.cardGrade, cert.CardGrade, true);
      return { status: mismatches.length ? 'record_mismatch' : 'record_matches', returned, mismatches, error: null };
    },
  };
}
