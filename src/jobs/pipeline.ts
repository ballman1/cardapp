/**
 * Analysis pipeline (§10): image extraction → catalog resolution → targeted
 * questions → condition observations → retrieval → deterministic valuation →
 * evidence-grounded explanation. Each stage persists its output so a retry
 * does not repeat successful work.
 */
import crypto from 'node:crypto';
import { ModelError } from '../ai/client.js';
import { deterministicExplanation, frozenView, nextBestAction, validateExplanation } from '../ai/explain.js';
import { ExtractionZ, type Extraction } from '../ai/schemas.js';
import type { AppContext } from '../context.js';
import { audit, tx } from '../db.js';
import { authenticityGate, fieldsFromExtraction, gradeInfo, identityGate, identityLabel, matchIdentity } from '../domain/identity.js';
import type { Category, IdentityFields, SaleRecord, SaleRecordInput } from '../domain/types.js';
import { cropRegion, modelInputDataUrl } from '../images/ingest.js';
import { fxKey } from '../providers/fx.js';
import { ProviderError } from '../providers/types.js';
import { runValuation } from '../valuation/engine.js';
import { DEFAULT_SETTINGS } from '../valuation/settings.js';
import { addCost, setStage, type JobRow } from './queue.js';

export class PermanentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const newEvidenceId = () => `ev_${crypto.randomBytes(9).toString('base64url')}`;

async function setCardState(ctx: AppContext, cardId: string, state: string) {
  await ctx.db.query('UPDATE card_instances SET analysis_state=$2, updated_at=now() WHERE id=$1', [cardId, state]);
}

async function loadAsset(ctx: AppContext, assetId: string) {
  const r = await ctx.db.query('SELECT * FROM assets WHERE id=$1', [assetId]);
  return r.rows[0];
}

/** Current (non-superseded) analysis copies for front/back/details. */
export async function currentImages(ctx: AppContext, cardId: string) {
  const r = await ctx.db.query(
    `SELECT a.*, p.kind AS parent_kind, p.label AS parent_label FROM assets a JOIN assets p ON p.id=a.parent_asset_id
     WHERE a.card_id=$1 AND a.kind='analysis_copy' AND NOT p.superseded ORDER BY a.created_at`,
    [cardId],
  );
  const front = r.rows.filter((x) => x.parent_kind === 'front').at(-1);
  const back = r.rows.filter((x) => x.parent_kind === 'back').at(-1);
  const details = r.rows.filter((x) => x.parent_kind === 'detail');
  return { front, back, details };
}

// ---------------------------------------------------------------------------
// Stage: extraction
// ---------------------------------------------------------------------------

export async function runExtract(ctx: AppContext, job: JobRow) {
  const cardId = job.card_id;
  const card = (await ctx.db.query('SELECT * FROM card_instances WHERE id=$1', [cardId])).rows[0];
  if (!card) throw new PermanentError('card_missing', 'Card no longer exists.');
  const imgs = await currentImages(ctx, cardId);
  if (!imgs.front || !imgs.back) {
    await setCardState(ctx, cardId, 'needs_photos');
    throw new PermanentError('needs_photos', 'Front and back photos are both required.');
  }

  // Reuse an extraction already persisted for this exact job (retry after a later failure).
  let extractionRow = (await ctx.db.query('SELECT * FROM extractions WHERE job_id=$1', [job.id])).rows[0];
  if (!extractionRow) {
    await setStage(ctx.db, job.id, 'model_extraction');
    const provenance = (await ctx.db.query('SELECT kind, statement FROM provenance_claims WHERE card_id=$1 ORDER BY created_at', [cardId])).rows;
    const answered = (await ctx.db.query(`SELECT text, answer FROM questions WHERE card_id=$1 AND answer_status='answered'`, [cardId])).rows;
    const ownerContext = [
      card.owner_notes ? `Additional information: ${card.owner_notes}` : '',
      ...provenance.map((p) => `Provenance (${p.kind}): ${p.statement}`),
      ...answered.map((a) => `Q: ${a.text} A: ${a.answer}`),
    ].filter(Boolean).join('\n');
    const toUrl = async (a: any) => modelInputDataUrl(await ctx.store.get(a.storage_key));
    let res;
    try {
      res = await ctx.model.extract({
        front: { dataUrl: await toUrl(imgs.front) },
        back: { dataUrl: await toUrl(imgs.back) },
        details: await Promise.all(imgs.details.slice(0, 4).map(async (d) => ({ dataUrl: await toUrl(d), caption: d.parent_label ?? '' }))),
        ownerContext,
        categoryHint: card.category_hint,
        rawOrGradedHint: card.raw_or_graded,
      });
    } catch (e) {
      const usage = (e as any)?.usage;
      if (usage) await addCost(ctx.db, job.id, usage);
      throw e;
    }
    await addCost(ctx.db, job.id, res.usage);
    const meta = ctx.model.meta('extraction');
    extractionRow = (
      await ctx.db.query(
        `INSERT INTO extractions (card_id, job_id, model_id, reasoning_effort, prompt_version, schema_version, input_asset_ids, output, usage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [cardId, job.id, meta.modelId, meta.reasoningEffort, meta.promptVersion, meta.schemaVersion, JSON.stringify([imgs.front.id, imgs.back.id, ...imgs.details.map((d) => d.id)]), JSON.stringify(res.output), JSON.stringify(res.usage)],
      )
    ).rows[0];
  }
  const x: Extraction = ExtractionZ.parse(extractionRow.output);

  await setStage(ctx.db, job.id, 'post_extraction');
  const { fields, notes } = fieldsFromExtraction(x);

  // Derived crops (labeled, linked to the immutable original's analysis copy).
  const existingCrops = await ctx.db.query(`SELECT 1 FROM assets WHERE card_id=$1 AND kind='crop' AND quality->>'extraction_id'=$2 LIMIT 1`, [cardId, extractionRow.id]);
  if (!existingCrops.rowCount) {
    for (const reg of x.regions) {
      if (!reg.bbox) continue;
      const src = reg.image === 'front' ? imgs.front : imgs.back;
      const crop = await cropRegion(await ctx.store.get(src.storage_key), reg.bbox).catch(() => null);
      if (!crop) continue;
      const key = await ctx.store.put(crop, 'jpg');
      await ctx.db.query(
        `INSERT INTO assets (user_id, card_id, kind, parent_asset_id, label, storage_key, mime, bytes, sha256, bbox, quality)
         VALUES ($1,$2,'crop',$3,$4,$5,'image/jpeg',$6,$7,$8,$9)`,
        [card.user_id, cardId, src.id, `${reg.image}:${reg.label}`, key, crop.length, crypto.createHash('sha256').update(crop).digest('hex'), JSON.stringify(reg.bbox), JSON.stringify({ extraction_id: extractionRow.id, note: reg.note })],
      );
    }
  }

  await tx(ctx.db, async (c) => {
    await c.query('DELETE FROM observations WHERE extraction_id=$1', [extractionRow.id]);
    for (const o of x.condition_observations) {
      await c.query(
        `INSERT INTO observations (card_id, extraction_id, aspect, image, status, severity, bbox, bbox_reliable, explanation, attributed_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [cardId, extractionRow.id, o.aspect, o.image, o.status, o.severity, o.bbox ? JSON.stringify(o.bbox) : null, o.bbox_reliable, o.explanation, o.attributed_to],
      );
    }
    const exists = await c.query('SELECT 1 FROM identity_versions WHERE extraction_id=$1', [extractionRow.id]);
    if (!exists.rowCount) {
      const v = (await c.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM identity_versions WHERE card_id=$1', [cardId])).rows[0].v;
      const conflicts = Object.entries(fields).filter(([, f]) => f?.status === 'conflicting').map(([k]) => k);
      const iv = await c.query(
        `INSERT INTO identity_versions (card_id, version, source, extraction_id, fields, candidates, conflicts, ai_suggestion, confirmed)
         VALUES ($1,$2,'model',$3,$4,$5,$6,$4,false) RETURNING id`,
        [cardId, v, extractionRow.id, JSON.stringify(fields), JSON.stringify(x.candidates), JSON.stringify(conflicts)],
      );
      await c.query('UPDATE card_instances SET current_identity_version_id=$2, title=$3 WHERE id=$1', [cardId, iv.rows[0].id, identityLabel(fields)]);
      // Targeted questions: ≤4, skip anything already readable in the photos.
      const round = (await c.query('SELECT COALESCE(MAX(round),0)+1 AS r FROM questions WHERE card_id=$1', [cardId])).rows[0].r;
      const qs = x.questions
        .filter((q) => !(q.field && fields[q.field]?.status === 'observed' && fields[q.field]?.value))
        .slice(0, 4);
      for (const q of qs) {
        await c.query(`INSERT INTO questions (card_id, round, code, field, text, reason, options) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [cardId, round, q.code, q.field, q.text, q.reason, JSON.stringify(q.options)]);
      }
    }
    if (notes.length) await c.query(`UPDATE extractions SET validation_notes=$2 WHERE id=$1`, [extractionRow.id, JSON.stringify(notes)]);
  });

  const blocking = x.front_back_consistency === 'inconsistent' || x.front_back_consistency === 'back_missing' || x.multiple_cards_detected || !x.images_show_single_card;
  await setCardState(ctx, cardId, blocking ? 'needs_photos' : 'needs_identification');
  await audit(ctx.db, card.user_id, cardId, 'extraction_completed', { extraction_id: extractionRow.id, blocking });
}

// ---------------------------------------------------------------------------
// Stage: certificate check → retrieval → valuation → explanation
// ---------------------------------------------------------------------------

export async function runValue(ctx: AppContext, job: JobRow) {
  const cardId = job.card_id;
  const identityVersionId = String(job.payload.identityVersionId);
  const card = (await ctx.db.query('SELECT * FROM card_instances WHERE id=$1', [cardId])).rows[0];
  if (!card) throw new PermanentError('card_missing', 'Card no longer exists.');
  const iv = (await ctx.db.query('SELECT * FROM identity_versions WHERE id=$1 AND card_id=$2', [identityVersionId, cardId])).rows[0];
  if (!iv) throw new PermanentError('identity_missing', 'Identity version missing.');
  if (!iv.confirmed) throw new PermanentError('identity_unconfirmed', 'Identity must be confirmed before valuation.');
  await setCardState(ctx, cardId, 'retrieving_sales');

  const fields: IdentityFields = iv.fields;
  const ext = iv.extraction_id
    ? (await ctx.db.query('SELECT output FROM extractions WHERE id=$1', [iv.extraction_id])).rows[0]
    : (await ctx.db.query(`SELECT e.output FROM identity_versions v JOIN extractions e ON e.id=v.extraction_id WHERE v.card_id=$1 ORDER BY v.version DESC LIMIT 1`, [cardId])).rows[0];
  const extraction: Extraction | null = ext ? ExtractionZ.parse(ext.output) : null;
  const grade = gradeInfo(fields, card.raw_or_graded);
  const ident = matchIdentity(fields);
  const category = (fields.category?.value ?? card.category_hint ?? null) as Category | null;

  // 1. Certificate check (once per identity version).
  await setStage(ctx.db, job.id, 'certificate_check');
  let cert = (await ctx.db.query('SELECT * FROM certificate_checks WHERE identity_version_id=$1 ORDER BY checked_at DESC LIMIT 1', [identityVersionId])).rows[0];
  const certNumber = fields.cert_number?.value;
  if (!cert && grade.state === 'graded' && certNumber && grade.grader) {
    const p = ctx.registry.certProviderFor(grade.grader);
    let result;
    if (!p || p.status() !== 'connected' || !p.verifyCertificate) {
      result = { status: p ? 'lookup_unavailable' : 'not_checked', returned: null, mismatches: [], error: p ? p.statusDetail() : `No verification service connected for ${grade.grader}.` };
    } else {
      try {
        result = await p.verifyCertificate(grade.grader, certNumber, { year: fields.release_year?.value, subject: fields.subject?.value, cardNumber: fields.card_number?.value, cardGrade: grade.cardGrade });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === 'rate_limited') throw new ModelError('rate_limited', e.message, true);
        result = { status: 'lookup_unavailable', returned: null, mismatches: [], error: (e as Error).message };
      }
    }
    cert = (
      await ctx.db.query(
        `INSERT INTO certificate_checks (card_id, identity_version_id, grader, cert_number, provider, status, returned, mismatches, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [cardId, identityVersionId, grade.grader, certNumber, p?.descriptor.id ?? 'none', result.status, result.returned ? JSON.stringify(result.returned) : null, JSON.stringify(result.mismatches), result.error],
      )
    ).rows[0];
  }

  // 2. Retrieval (persisted; a retry reuses it).
  await setStage(ctx.db, job.id, 'retrieval');
  let retrieval = (await ctx.db.query('SELECT * FROM retrievals WHERE job_id=$1', [job.id])).rows[0];
  if (!retrieval) {
    const sources: any[] = [];
    const collected: { input: SaleRecordInput; provider: string }[] = [];
    const maxDays = DEFAULT_SETTINGS.windowsDays.at(-1)!;
    const query = { identityVersionId, identity: ident, grade, category, windowDays: maxDays, maxResults: DEFAULT_SETTINGS.maxCandidateEvents, cursor: null, cardId, userId: card.user_id };
    for (const p of ctx.registry.all()) {
      const d = p.descriptor;
      const relevant = !category || d.categories.includes(category);
      const status = p.status();
      if (!d.purposes.includes('individual_sale')) continue;
      if (!relevant) {
        sources.push({ provider: d.id, name: d.name, searched: false, status, reason: 'Not relevant to this category' });
        continue;
      }
      if (status !== 'connected') {
        sources.push({ provider: d.id, name: d.name, searched: false, status, reason: p.statusDetail() });
        continue;
      }
      if (d.id === 'owner_supplied') {
        const n = (await ctx.db.query(`SELECT count(*)::int AS n FROM sales_records WHERE card_id=$1 AND acquisition_method='owner_supplied'`, [cardId])).rows[0].n;
        sources.push({ provider: d.id, name: d.name, searched: true, status, retrievedAt: new Date().toISOString(), windowDays: null, count: n, truncated: false, query: 'Owner-entered records for this card' });
        continue;
      }
      if (!p.searchSales) continue;
      const started = new Date().toISOString();
      try {
        const res = await p.searchSales(query);
        const capped = res.records.slice(0, DEFAULT_SETTINGS.maxCandidateEvents);
        collected.push(...capped.map((input) => ({ input, provider: d.id })));
        sources.push({ provider: d.id, name: d.name, searched: true, status, retrievedAt: started, windowDays: maxDays, count: capped.length, truncated: res.truncated || res.records.length > capped.length, query: res.queryDescription });
      } catch (e) {
        sources.push({ provider: d.id, name: d.name, searched: false, attempted: true, status: e instanceof ProviderError ? e.kind : 'temporarily_unavailable', retrievedAt: started, failure: (e as Error).message.slice(0, 300) });
      }
    }
    retrieval = await tx(ctx.db, async (c) => {
      const r = (await c.query('INSERT INTO retrievals (card_id, identity_version_id, job_id, sources) VALUES ($1,$2,$3,$4) RETURNING *', [cardId, identityVersionId, job.id, JSON.stringify(sources)])).rows[0];
      for (const { input, provider } of collected) {
        await c.query(
          `INSERT INTO sales_records (evidence_id, user_id, card_id, retrieval_id, provider, origin_marketplace, source_record_id, canonical_url, acquisition_method, is_fixture, retrieved_at, record)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [newEvidenceId(), card.user_id, cardId, r.id, provider, input.originMarketplace, input.sourceRecordId, input.canonicalUrl, input.acquisitionMethod, input.isFixture, input.retrievedAt, JSON.stringify(input)],
        );
      }
      return r;
    });
  }

  // 3. Deterministic valuation.
  await setStage(ctx.db, job.id, 'valuation');
  const recRows = (
    await ctx.db.query(
      `SELECT evidence_id, record FROM sales_records WHERE card_id=$1 AND (retrieval_id=$2 OR (retrieval_id IS NULL AND acquisition_method='owner_supplied')) ORDER BY evidence_id`,
      [cardId, retrieval.id],
    )
  ).rows;
  const records: SaleRecord[] = recRows.map((r) => ({ ...(r.record as SaleRecordInput), evidenceId: r.evidence_id }));
  const excluded = (await ctx.db.query(`SELECT DISTINCT evidence_id FROM comp_flags WHERE card_id=$1 AND action='exclude_next_run'`, [cardId])).rows.map((r) => r.evidence_id);

  const fxPairs = [...new Set(records.filter((r) => r.currency.toUpperCase() !== card.currency).map((r) => fxKey(r.currency.toUpperCase(), card.currency, r.saleDate.slice(0, 10))))].map((k) => {
    const [from, to, date] = k.split(':');
    return { from: from!, to: to!, date: date! };
  });
  const fxRates = await ctx.fx.fetchRates(fxPairs);

  const idGate = identityGate(fields, iv.confirmed, iv.candidates ?? []);
  const authGate = authenticityGate(fields, extraction, cert ? { status: cert.status, mismatches: cert.mismatches } : null);
  const subject = { identity: ident, grade, rawConditionBand: grade.state === 'raw' ? (extraction?.condition_band ?? null) : null };
  const gates = { identityResolved: idGate.resolved, identityIssues: idGate.issues, authenticity: authGate.authenticity, authenticityIssues: authGate.issues, conditionalScenario: authGate.scenario };
  const valuationDate = new Date().toISOString();
  const result = runValuation({
    subject, records, valuationDate, currency: card.currency, gates,
    fx: (from, to, date) => fxRates.get(fxKey(from, to, date)) ?? null,
    userExcludedEvidenceIds: excluded,
    retrievalTruncated: (retrieval.sources as any[]).some((s) => s.truncated),
  });

  // 4. Explanation (model, validated) with deterministic fallback.
  await setStage(ctx.db, job.id, 'explanation');
  const label = identityLabel(fields);
  const certStatus = cert?.status ?? (grade.state === 'graded' ? 'not_checked' : 'n/a (raw)');
  const searched = (retrieval.sources as any[]).filter((s) => s.searched).map((s) => s.name);
  const frozen = frozenView(result, label, certStatus, searched);
  const allowedIds = result.records.map((r) => r.evidenceId);
  const nba = nextBestAction(result, { certStatus, requestedPhotos: (extraction?.requested_photos ?? []).map((p) => `${p.region} (${p.lighting} light) — ${p.why}`), identityIssues: idGate.issues, authenticityIssues: authGate.issues });
  let explanation = deterministicExplanation(result, nba);
  let explanationMeta: Record<string, unknown> = { source: 'deterministic' };
  const meta = ctx.model.meta('explanation');
  try {
    const ex = await ctx.model.explain(frozen, allowedIds);
    await addCost(ctx.db, job.id, ex.usage);
    const problems = validateExplanation(ex.output, frozen, allowedIds);
    if (problems.length === 0) {
      explanation = ex.output;
      explanationMeta = { source: 'model', ...meta };
    } else {
      explanationMeta = { source: 'deterministic_fallback', reason: 'model explanation failed validation', problems, ...meta };
    }
  } catch (e) {
    const me = e instanceof ModelError ? e : null;
    explanationMeta = { source: 'deterministic_fallback', reason: me ? `${me.code}: ${me.message}` : (e as Error).message, ...meta };
  }

  await tx(ctx.db, async (c) => {
    const rev = (await c.query('SELECT COALESCE(MAX(report_revision),0)+1 AS r FROM valuation_runs WHERE card_id=$1', [cardId])).rows[0].r;
    const run = await c.query(
      `INSERT INTO valuation_runs (card_id, user_id, identity_version_id, retrieval_id, report_revision, calc_version, settings, inputs, result, explanation, explanation_meta, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [cardId, card.user_id, identityVersionId, retrieval.id, rev, result.calcVersion, JSON.stringify(result.settings),
        JSON.stringify({ subject, gates, evidenceIds: records.map((r) => r.evidenceId), userExcluded: excluded, valuationDate, currency: card.currency, fxRates: Object.fromEntries(fxRates), certCheckId: cert?.id ?? null, autographStatus: authGate.autographStatus, relicStatus: authGate.relicStatus, nextBestAction: nba }),
        JSON.stringify(result), JSON.stringify(explanation), JSON.stringify(explanationMeta), result.reportState],
    );
    for (const g of result.duplicateGroups) {
      await c.query('INSERT INTO duplicate_groups (valuation_run_id, primary_evidence_id, member_evidence_ids, reasons) VALUES ($1,$2,$3,$4)', [run.rows[0].id, g.primaryEvidenceId, JSON.stringify(g.memberEvidenceIds), JSON.stringify(g.reasons)]);
    }
    await c.query('UPDATE card_instances SET analysis_state=$2, updated_at=now() WHERE id=$1', [cardId, result.reportState]);
    await c.query('INSERT INTO audit_events (user_id, card_id, kind, payload) VALUES ($1,$2,$3,$4)', [card.user_id, cardId, 'valuation_completed', JSON.stringify({ valuation_run_id: run.rows[0].id, revision: rev, identity_version_id: identityVersionId })]);
  });
}
