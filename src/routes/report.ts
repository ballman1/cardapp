/**
 * Report assembly (§9), printable HTML and CSV export (§3 Screen F).
 * Provider display/export rights are applied here.
 */
import type { AppContext } from '../context.js';
import { fmtMoney } from '../ai/explain.js';
import { identityLabel } from '../domain/identity.js';
import type { ValuationResult } from '../valuation/engine.js';

export const REPORT_NOTICE =
  'This estimate uses the photographs and sales evidence available on the report date. Photo condition observations are not professional grading or authentication. Actual sale proceeds depend on condition, buyer demand and selling costs.';

export async function buildReport(ctx: AppContext, card: any, runId: string) {
  const run = (await ctx.db.query('SELECT * FROM valuation_runs WHERE id=$1 AND card_id=$2', [runId, card.id])).rows[0];
  if (!run) return null;
  const result = run.result as ValuationResult;
  const iv = (await ctx.db.query('SELECT * FROM identity_versions WHERE id=$1', [run.identity_version_id])).rows[0];
  const retrieval = run.retrieval_id ? (await ctx.db.query('SELECT * FROM retrievals WHERE id=$1', [run.retrieval_id])).rows[0] : null;
  const recs = (await ctx.db.query('SELECT evidence_id, provider, record FROM sales_records WHERE evidence_id = ANY($1::text[]) AND card_id=$2', [run.inputs.evidenceIds, card.id])).rows;
  const byId = new Map(recs.map((r) => [r.evidence_id, r]));
  const cert = run.inputs.certCheckId ? (await ctx.db.query('SELECT * FROM certificate_checks WHERE id=$1', [run.inputs.certCheckId])).rows[0] : null;
  const provenance = (await ctx.db.query('SELECT kind, statement, verification_status, created_at FROM provenance_claims WHERE card_id=$1 ORDER BY created_at', [card.id])).rows;
  const observations = iv?.extraction_id ? (await ctx.db.query('SELECT aspect, image, status, severity, explanation, attributed_to, bbox, user_bbox, bbox_reliable FROM observations WHERE extraction_id=$1 ORDER BY image, aspect', [iv.extraction_id])).rows : [];
  const extraction = iv?.extraction_id ? (await ctx.db.query('SELECT model_id, reasoning_effort, prompt_version, schema_version, output, created_at FROM extractions WHERE id=$1', [iv.extraction_id])).rows[0] : null;
  const images = (await ctx.db.query(`SELECT a.id, p.kind FROM assets a JOIN assets p ON p.id=a.parent_asset_id WHERE a.card_id=$1 AND a.kind='analysis_copy' AND p.kind IN ('front','back') AND p.created_at <= $2 ORDER BY a.created_at`, [card.id, run.created_at])).rows;
  const flags = (await ctx.db.query('SELECT evidence_id, action, reason, created_at FROM comp_flags WHERE card_id=$1', [card.id])).rows;
  const latestRev = (await ctx.db.query('SELECT MAX(report_revision) AS r FROM valuation_runs WHERE card_id=$1', [card.id])).rows[0].r;

  const comps = result.records.map((a) => {
    const row = byId.get(a.evidenceId);
    const r = row?.record ?? {};
    const provider = ctx.registry.get(row?.provider ?? '');
    const display = provider ? provider.descriptor.rights.displayAllowed : true;
    return {
      ...a,
      provider: row?.provider ?? 'unknown',
      originMarketplace: r.originMarketplace,
      url: display ? r.canonicalUrl : null,
      saleDate: r.saleDate,
      title: display ? r.originalTitle : '[hidden: provider display rights]',
      saleFormat: r.saleFormat,
      originalCurrency: r.currency,
      reportedAmountMinor: r.reportedAmountMinor,
      priceBasis: r.priceBasis,
      isFixture: r.isFixture,
      acquisitionMethod: r.acquisitionMethod,
      exportAllowed: provider ? provider.descriptor.rights.exportAllowed : false,
      userFlags: flags.filter((f) => f.evidence_id === a.evidenceId),
    };
  });

  return {
    notice: REPORT_NOTICE,
    run: { id: run.id, revision: run.report_revision, latestRevision: latestRev, createdAt: run.created_at, state: run.state, calcVersion: run.calc_version },
    card: { id: card.id, currency: card.currency, valuationPurpose: card.valuation_purpose, marketRegion: card.market_region },
    identity: iv ? { id: iv.id, version: iv.version, source: iv.source, label: identityLabel(iv.fields), fields: iv.fields, aiSuggestion: iv.ai_suggestion, correctionDiff: iv.correction_diff, confirmed: iv.confirmed } : null,
    images,
    observations,
    conditionBand: extraction?.output?.condition_band ?? null,
    conditionBandRationale: extraction?.output?.condition_band_rationale ?? null,
    centering: extraction?.output?.centering ?? null,
    autographStatus: run.inputs.autographStatus,
    relicStatus: run.inputs.relicStatus,
    provenance,
    certificate: cert ? { grader: cert.grader, certNumber: cert.cert_number, provider: cert.provider, status: cert.status, mismatches: cert.mismatches, checkedAt: cert.checked_at, error: cert.error, note: 'A matching record does not authenticate the physical holder.' } : null,
    result,
    comps,
    sources: retrieval?.sources ?? [],
    explanation: run.explanation,
    explanationMeta: run.explanation_meta,
    nextBestAction: run.inputs.nextBestAction,
    audit: {
      extractionModel: extraction?.model_id ?? null,
      reasoningEffort: extraction?.reasoning_effort ?? null,
      promptVersion: extraction?.prompt_version ?? null,
      schemaVersion: extraction?.schema_version ?? null,
      explanationMeta: run.explanation_meta,
      calcVersion: run.calc_version,
      valuationTimestamp: run.inputs.valuationDate,
      reportRevision: run.report_revision,
      identityVersion: iv?.version,
    },
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function printableReport(rep: NonNullable<Awaited<ReturnType<typeof buildReport>>>): string {
  const r = rep.result;
  const cur = r.currency;
  const h = r.headline;
  const money = (m: number | null) => esc(fmtMoney(m, cur) ?? '—');
  const compRows = rep.comps
    .map((c) => `<tr><td>${esc(c.evidenceId)}</td><td>${esc(c.saleDate)}</td><td>${esc(c.provider)} / ${esc(c.originMarketplace)}${c.isFixture ? ' <b>[FIXTURE]</b>' : ''}</td><td>${c.url ? `<a href="${esc(c.url)}">${esc(c.title)}</a>` : esc(c.title)}</td><td>${esc(c.gradeLabel)}</td><td>${esc(c.originalCurrency)} ${c.reportedAmountMinor == null ? '—' : esc((c.reportedAmountMinor / 100).toFixed(2))} (${esc(c.priceBasis)})</td><td>${money(c.normalizedMinor)}</td><td>${esc(c.tier ?? '—')}${c.pool ? ` / ${esc(c.pool)}` : ''}</td><td>${c.exclusionText.length ? esc(c.exclusionText.join(' ')) : 'Included'} ${esc(c.notes.join(' '))} ${esc(c.flags.join(' '))}</td></tr>`)
    .join('');
  const fields = Object.entries(rep.identity?.fields ?? {})
    .filter(([, f]: any) => f?.value)
    .map(([k, f]: any) => `<tr><td>${esc(k)}</td><td>${esc(f.value)}</td><td>${esc(f.status)}</td><td>${esc(f.evidence ?? '')}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Card report r${rep.run.revision}</title>
<style>body{font:13px/1.45 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#111}table{border-collapse:collapse;width:100%;margin:8px 0 16px}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}h1{font-size:20px}h2{font-size:15px;margin-top:22px}.banner{background:#fee;border:2px solid #c00;padding:8px;font-weight:700}.muted{color:#555}img{max-width:240px;margin-right:8px;border:1px solid #ccc}</style></head><body>
${r.containsFixtureData ? '<div class="banner">FIXTURE DATA — synthetic records for testing only. This is not a market valuation.</div>' : ''}
<h1>${esc(rep.identity?.label)}</h1>
<p class="muted">Report revision ${rep.run.revision}${rep.run.revision !== rep.run.latestRevision ? ` (superseded — latest is ${rep.run.latestRevision})` : ''} · Valuation ${esc(rep.audit.valuationTimestamp)} · Identity version ${esc(rep.identity?.version)} (${esc(rep.identity?.source)})</p>
<div>${rep.images.map((i: any) => `<img src="/api/assets/${esc(i.id)}" alt="${esc(i.kind)}">`).join('')}</div>
<h2>Value</h2>
<p><b>${esc(h.kind.replace(/_/g, ' '))}</b>: ${h.display.central != null ? `central ${money(h.display.central)}; ` : ''}${h.display.low != null ? `range ${money(h.display.low)} – ${money(h.display.high)}` : ''}</p>
<p>${esc(h.statement)}</p>
<p class="muted">Currency ${esc(cur)} · Basis: ${esc(r.priceBasis)} · Subject: ${esc(r.subjectGrade)} · Direct comps ${r.precise.eventCount} (independent ${r.precise.independentEventCount}, effective sample ${r.precise.effectiveSampleSize.toFixed(1)}) · Window ${r.window.selectedDays} days · Dispersion ${r.precise.logDispersion.toFixed(2)}</p>
<h2>Confidence</h2><table><tr><th>Identity</th><td>${esc(r.confidence.identity)}</td></tr><tr><th>Condition visibility</th><td>${esc(r.confidence.conditionVisibility)}</td></tr><tr><th>Authenticity / record</th><td>${esc(r.confidence.authenticity)}</td></tr><tr><th>Market evidence</th><td>${esc(r.confidence.marketEvidence)}</td></tr><tr><th>Autograph</th><td>${esc(rep.autographStatus)}</td></tr><tr><th>Relic</th><td>${esc(rep.relicStatus)}</td></tr></table>
${r.flags.length ? `<h2>Flags</h2><ul>${r.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
<h2>Explanation</h2><p>${esc(rep.explanation?.summary)}</p><ul>${(rep.explanation?.points ?? []).map((p: any) => `<li>${esc(p.text)} <span class="muted">${esc(p.evidence_ids.join(', '))}</span></li>`).join('')}</ul>
<p><b>Next best action:</b> ${esc(rep.nextBestAction)}</p>
<h2>Identity</h2><table><tr><th>Field</th><th>Value</th><th>Status</th><th>Evidence</th></tr>${fields}</table>
<h2>Certification</h2><p>${rep.certificate ? `${esc(rep.certificate.grader)} ${esc(rep.certificate.certNumber)}: <b>${esc(rep.certificate.status)}</b> via ${esc(rep.certificate.provider)} on ${esc(rep.certificate.checkedAt)}. ${esc(rep.certificate.note)}` : 'Not applicable / not checked.'}</p>
<h2>Condition observations (photo-based; not a professional grade)</h2><p>Band: ${esc(rep.conditionBand ?? 'n/a')} — ${esc(rep.conditionBandRationale ?? '')}</p>
<table><tr><th>Image</th><th>Aspect</th><th>Status</th><th>Severity</th><th>Attributed to</th><th>Note</th></tr>${rep.observations.map((o: any) => `<tr><td>${esc(o.image)}</td><td>${esc(o.aspect)}</td><td>${esc(o.status)}</td><td>${esc(o.severity ?? '')}</td><td>${esc(o.attributed_to)}</td><td>${esc(o.explanation)}</td></tr>`).join('')}</table>
<h2>Provenance (owner-reported unless stated)</h2><ul>${rep.provenance.map((p: any) => `<li>[${esc(p.verification_status)}] ${esc(p.kind)}: ${esc(p.statement)}</li>`).join('') || '<li>None provided</li>'}</ul>
<h2>Comparable sales — included and excluded</h2><table><tr><th>ID</th><th>Date</th><th>Source</th><th>Title</th><th>Grade</th><th>Reported</th><th>Normalized</th><th>Tier/pool</th><th>Decision</th></tr>${compRows || '<tr><td colspan="9">No records retrieved.</td></tr>'}</table>
${r.guideBenchmarks.length ? `<h2>Guide benchmarks (aggregate, not sales)</h2><ul>${r.guideBenchmarks.map((g) => `<li>${esc(g.provider)}: ${money(g.valueMinor)} as of ${esc(g.asOf)} — ${esc(g.note)}</li>`).join('')}</ul>` : ''}
<h2>Sources</h2><table><tr><th>Source</th><th>Searched</th><th>Status</th><th>Detail</th></tr>${(rep.sources as any[]).map((s) => `<tr><td>${esc(s.name)}</td><td>${s.searched ? 'yes' : 'no'}</td><td>${esc(s.status)}</td><td>${esc(s.searched ? `${s.count} record(s), window ${s.windowDays ?? 'n/a'} days, retrieved ${s.retrievedAt}${s.truncated ? ', TRUNCATED' : ''}` : s.failure ?? s.reason ?? '')}</td></tr>`).join('')}</table>
<h2>Audit</h2><p class="muted">Extraction model ${esc(rep.audit.extractionModel)} (effort ${esc(rep.audit.reasoningEffort)}), prompts ${esc(rep.audit.promptVersion)}, schema ${esc(rep.audit.schemaVersion)}, calculation ${esc(rep.audit.calcVersion)}, explanation source ${esc((rep.audit.explanationMeta as any)?.source)}.</p>
<p><i>${esc(rep.notice)}</i></p>
</body></html>`;
}

const csvCell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula-injection guard
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function collectionCsv(ctx: AppContext, userId: string): Promise<string> {
  const rows = (
    await ctx.db.query(
      `SELECT c.id, c.title, c.analysis_state, c.currency, col.name AS collection, v.report_revision, v.created_at AS valued_at, v.result
       FROM card_instances c LEFT JOIN collections col ON col.id=c.collection_id
       LEFT JOIN LATERAL (SELECT * FROM valuation_runs vr WHERE vr.card_id=c.id ORDER BY report_revision DESC LIMIT 1) v ON true
       WHERE c.user_id=$1 ORDER BY c.created_at`,
      [userId],
    )
  ).rows;
  const header = ['card_id', 'collection', 'title', 'analysis_state', 'report_revision', 'valued_at', 'value_status', 'currency', 'central', 'low', 'high', 'market_evidence', 'direct_comps', 'window_days', 'price_basis', 'fixture_data', 'evidence_urls_exportable'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const res = r.result as ValuationResult | null;
    const h = res?.headline;
    const stale = r.valued_at && (Date.now() - new Date(r.valued_at).getTime()) / 86_400_000 > 90;
    const status = !res ? 'missing' : res.containsFixtureData ? 'fixture_not_real' : h!.kind === 'suppressed' || h!.kind === 'conditional' ? 'conditional' : h!.centralMinor == null ? 'limited_or_insufficient' : stale ? 'stale' : 'supported';
    // Evidence URLs only from providers whose rights allow export.
    let urls = '';
    if (res) {
      const ids = res.records.filter((a) => a.pool === 'precise').map((a) => a.evidenceId);
      const recs = ids.length ? (await ctx.db.query('SELECT provider, canonical_url FROM sales_records WHERE evidence_id = ANY($1::text[])', [ids])).rows : [];
      urls = recs.filter((x) => ctx.registry.get(x.provider)?.descriptor.rights.exportAllowed).map((x) => x.canonical_url).filter(Boolean).join(' ');
    }
    const d = (m: number | null | undefined) => (m == null ? '' : (m / 100).toFixed(0));
    lines.push([r.id, r.collection, r.title, r.analysis_state, r.report_revision ?? '', r.valued_at ? new Date(r.valued_at).toISOString() : '', status, r.currency, d(h?.display.central), d(h?.display.low), d(h?.display.high), res?.strength ?? '', res?.precise.eventCount ?? '', res?.window.selectedDays ?? '', res?.priceBasis ?? '', res?.containsFixtureData ? 'yes' : 'no', urls].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
