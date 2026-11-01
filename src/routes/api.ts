import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createSession, destroySession, hashPassword, requireAuth, SESSION_COOKIE, verifyPassword } from '../auth.js';
import type { AppContext } from '../context.js';
import { audit, tx } from '../db.js';
import { applyCorrections, identityLabel } from '../domain/identity.js';
import { CATEGORIES, GRADERS, IDENTITY_FIELD_NAMES, type IdentityFields, type SaleRecordInput } from '../domain/types.js';
import { ingestImage, sha256 } from '../images/ingest.js';
import { enqueue, requeue } from '../jobs/queue.js';
import { newEvidenceId } from '../jobs/pipeline.js';
import { buildReport, collectionCsv, printableReport } from './report.js';

const uuid = z.string().uuid();
const bad = (reply: FastifyReply, msg: string, code = 400) => reply.code(code).send({ error: msg });

export async function registerApi(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const auth = requireAuth(db);

  // ---------------- auth ----------------
  const Creds = z.object({ email: z.string().email().max(200), password: z.string().min(10).max(200) });
  const cookieOpts = (expires: Date) => ({ path: '/', httpOnly: true, sameSite: 'strict' as const, secure: ctx.cfg.env === 'production', expires });

  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (req.headers['x-requested-with'] !== 'cardvalue') return bad(reply, 'missing_csrf_header', 403);
    const p = Creds.safeParse(req.body);
    if (!p.success) return bad(reply, 'Email and a password of at least 10 characters are required.');
    const email = p.data.email.toLowerCase();
    const exists = await db.query('SELECT 1 FROM users WHERE email=$1', [email]);
    if (exists.rowCount) return bad(reply, 'An account with that email already exists.', 409);
    const u = await db.query('INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id', [email, await hashPassword(p.data.password)]);
    await db.query(`INSERT INTO collections (user_id, name) VALUES ($1, 'My collection')`, [u.rows[0].id]);
    const s = await createSession(db, u.rows[0].id);
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts(s.expires));
    return { id: u.rows[0].id, email };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (req.headers['x-requested-with'] !== 'cardvalue') return bad(reply, 'missing_csrf_header', 403);
    const p = Creds.safeParse(req.body);
    if (!p.success) return bad(reply, 'Invalid credentials.', 401);
    const u = (await db.query('SELECT id, email, password_hash FROM users WHERE email=$1', [p.data.email.toLowerCase()])).rows[0];
    if (!u || !(await verifyPassword(p.data.password, u.password_hash))) return bad(reply, 'Invalid credentials.', 401);
    const s = await createSession(db, u.id);
    reply.setCookie(SESSION_COOKIE, s.token, cookieOpts(s.expires));
    return { id: u.id, email: u.email };
  });

  app.post('/api/auth/logout', { preHandler: auth }, async (req, reply) => {
    await destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: auth }, async (req) => req.user);

  // ---------------- helpers ----------------
  async function ownedCard(userId: string, cardId: string) {
    if (!uuid.safeParse(cardId).success) return null;
    return (await db.query('SELECT * FROM card_instances WHERE id=$1 AND user_id=$2', [cardId, userId])).rows[0] ?? null;
  }

  // ---------------- system ----------------
  app.get('/api/connectors', { preHandler: auth }, async () => ({
    providers: ctx.registry.all().map((p) => ({ ...p.descriptor, status: p.status(), statusDetail: p.statusDetail() })),
    model: { id: ctx.cfg.openai.model, reasoningEffort: ctx.cfg.openai.reasoningEffort, configured: !!ctx.cfg.openai.apiKey },
    fx: ctx.fx.name,
    fixturesEnabled: ctx.cfg.allowFixtures,
  }));

  app.post('/api/system/model-check', { preHandler: auth, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async () => ctx.model.capabilityTest());

  // ---------------- cards ----------------
  const CardOpts = z.object({
    title: z.string().max(200).optional(),
    collectionId: uuid.nullable().optional(),
    categoryHint: z.enum(CATEGORIES).nullable().optional(),
    rawOrGraded: z.enum(['raw', 'graded']).nullable().optional(),
    ownershipStatus: z.enum(['owned', 'consigned', 'considering_purchase', 'other']).nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    marketRegion: z.string().max(40).optional(),
    valuationPurpose: z.enum(['ordinary_resale']).optional(),
    ownerNotes: z.string().max(10_000).optional(),
    purchasePriceMinor: z.number().int().nonnegative().nullable().optional(),
    purchaseCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  });

  app.get('/api/cards', { preHandler: auth }, async (req) => {
    const rows = (
      await db.query(
        `SELECT c.id, c.title, c.analysis_state, c.currency, c.created_at, c.updated_at, col.name AS collection,
                v.id AS run_id, v.report_revision, v.created_at AS valued_at, v.state AS run_state,
                v.result->'headline' AS headline, v.result->>'strength' AS strength, (v.result->>'containsFixtureData')::boolean AS fixture,
                (SELECT a.id FROM assets a JOIN assets p ON p.id=a.parent_asset_id WHERE a.card_id=c.id AND a.kind='analysis_copy' AND p.kind='front' AND NOT p.superseded ORDER BY a.created_at DESC LIMIT 1) AS thumb
         FROM card_instances c
         LEFT JOIN collections col ON col.id=c.collection_id
         LEFT JOIN LATERAL (SELECT * FROM valuation_runs vr WHERE vr.card_id=c.id ORDER BY report_revision DESC LIMIT 1) v ON true
         WHERE c.user_id=$1 ORDER BY c.updated_at DESC`,
        [req.user!.id],
      )
    ).rows;
    const collections = (await db.query('SELECT id, name FROM collections WHERE user_id=$1 ORDER BY name', [req.user!.id])).rows;
    return { cards: rows, collections, totals: collectionTotals(rows) };
  });

  app.post('/api/cards', { preHandler: auth }, async (req, reply) => {
    const p = CardOpts.safeParse(req.body ?? {});
    if (!p.success) return bad(reply, p.error.issues[0]?.message ?? 'invalid');
    const o = p.data;
    let collectionId = o.collectionId ?? null;
    if (collectionId) {
      const ok = await db.query('SELECT 1 FROM collections WHERE id=$1 AND user_id=$2', [collectionId, req.user!.id]);
      if (!ok.rowCount) return bad(reply, 'Unknown collection', 404);
    } else {
      collectionId = (await db.query('SELECT id FROM collections WHERE user_id=$1 ORDER BY created_at LIMIT 1', [req.user!.id])).rows[0]?.id ?? null;
    }
    const r = await db.query(
      `INSERT INTO card_instances (user_id, collection_id, title, category_hint, raw_or_graded, ownership_status, currency, market_region, valuation_purpose, owner_notes, purchase_price_minor, purchase_currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.user!.id, collectionId, o.title ?? null, o.categoryHint ?? null, o.rawOrGraded ?? null, o.ownershipStatus ?? null, o.currency ?? 'USD', o.marketRegion ?? 'US', o.valuationPurpose ?? 'ordinary_resale', o.ownerNotes ?? '', o.purchasePriceMinor ?? null, o.purchaseCurrency ?? null],
    );
    await audit(db, req.user!.id, r.rows[0].id, 'card_created', {});
    return { id: r.rows[0].id };
  });

  app.patch('/api/cards/:id', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const p = CardOpts.safeParse(req.body ?? {});
    if (!p.success) return bad(reply, p.error.issues[0]?.message ?? 'invalid');
    const o = p.data;
    const map: Record<string, unknown> = {
      title: o.title, category_hint: o.categoryHint, raw_or_graded: o.rawOrGraded, ownership_status: o.ownershipStatus, currency: o.currency,
      market_region: o.marketRegion, owner_notes: o.ownerNotes, purchase_price_minor: o.purchasePriceMinor, purchase_currency: o.purchaseCurrency,
    };
    const sets = Object.entries(map).filter(([, v]) => v !== undefined);
    if (sets.length) {
      await db.query(`UPDATE card_instances SET ${sets.map(([k], i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`, [card.id, ...sets.map(([, v]) => v)]);
      await audit(db, req.user!.id, card.id, 'card_updated', { fields: sets.map(([k]) => k) });
    }
    return { ok: true };
  });

  app.delete('/api/cards/:id', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const keys = (await db.query('SELECT storage_key FROM assets WHERE card_id=$1', [card.id])).rows.map((r) => r.storage_key);
    await db.query('DELETE FROM card_instances WHERE id=$1', [card.id]); // cascades to all card-scoped rows
    for (const k of keys) await ctx.store.delete(k).catch(() => {});
    await audit(db, req.user!.id, null, 'card_deleted', { card_id: card.id, files_deleted: keys.length });
    return { ok: true, filesDeleted: keys.length };
  });

  app.get('/api/cards/:id', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const q = (sql: string) => db.query(sql, [card.id]).then((r) => r.rows);
    const [assets, versions, questions, observations, provenance, certs, jobs, runs, ownerComps, flags] = await Promise.all([
      q(`SELECT id, kind, parent_asset_id, label, mime, bytes, width, height, quality, bbox, superseded, created_at FROM assets WHERE card_id=$1 ORDER BY created_at`),
      q(`SELECT id, version, source, based_on_version_id, extraction_id, fields, candidates, conflicts, ai_suggestion, correction_diff, confirmed, created_at FROM identity_versions WHERE card_id=$1 ORDER BY version`),
      q(`SELECT id, round, code, field, text, reason, options, answer, answer_status FROM questions WHERE card_id=$1 ORDER BY round, created_at`),
      q(`SELECT o.* FROM observations o JOIN identity_versions v ON v.extraction_id=o.extraction_id AND v.id=(SELECT current_identity_version_id FROM card_instances WHERE id=$1) ORDER BY o.image, o.aspect`),
      q(`SELECT id, kind, statement, document_asset_ids, verification_status, created_at FROM provenance_claims WHERE card_id=$1 ORDER BY created_at`),
      q(`SELECT * FROM certificate_checks WHERE card_id=$1 ORDER BY checked_at DESC`),
      q(`SELECT id, kind, state, stage, attempts, max_attempts, last_error_code, last_error, costs, created_at, updated_at FROM analysis_jobs WHERE card_id=$1 ORDER BY created_at DESC LIMIT 10`),
      q(`SELECT id, report_revision, identity_version_id, state, created_at, result->'headline' AS headline, result->>'strength' AS strength FROM valuation_runs WHERE card_id=$1 ORDER BY report_revision DESC`),
      q(`SELECT evidence_id, record, created_at FROM sales_records WHERE card_id=$1 AND acquisition_method='owner_supplied' ORDER BY created_at`),
      q(`SELECT evidence_id, action, reason, created_at FROM comp_flags WHERE card_id=$1 ORDER BY created_at`),
    ]);
    const extraction = versions.length
      ? (await db.query(`SELECT id, output, validation_notes, model_id, prompt_version, schema_version, created_at FROM extractions WHERE id=(SELECT extraction_id FROM identity_versions WHERE id=$1)`, [card.current_identity_version_id])).rows[0] ?? null
      : null;
    const { purchase_price_minor, ...rest } = card;
    return { card: { ...rest, purchasePriceMinor: purchase_price_minor }, assets, versions, questions, observations, provenance, certs, jobs, runs, ownerComps, flags, extraction };
  });

  // ---------------- assets ----------------
  app.post('/api/cards/:id/assets', { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const file = await req.file({ limits: { fileSize: ctx.cfg.maxUploadBytes, files: 1 } });
    if (!file) return bad(reply, 'No file uploaded.');
    const fields = file.fields as any;
    const kind = String(fields.kind?.value ?? '');
    const caption = String(fields.caption?.value ?? '').slice(0, 200);
    if (!['front', 'back', 'detail', 'document'].includes(kind)) return bad(reply, 'kind must be front, back, detail or document');
    const buf = await file.toBuffer();
    if (file.file.truncated) return bad(reply, 'File too large.', 413);
    const hash = sha256(buf);

    if (kind === 'document') {
      // Provenance documents: PDF or image only. Stored privately; not sent to pricing providers.
      const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
      let mime = isPdf ? 'application/pdf' : null;
      let bytes = buf;
      if (!isPdf) {
        try {
          const ing = await ingestImage(buf, ctx.cfg.maxImagePixels);
          mime = 'image/jpeg';
          bytes = ing.analysisJpeg; // metadata stripped
        } catch {
          return bad(reply, 'Documents must be PDF, JPEG, PNG or HEIC.');
        }
      }
      const key = await ctx.store.put(bytes, isPdf ? 'pdf' : 'jpg');
      const r = await db.query(`INSERT INTO assets (user_id, card_id, kind, label, storage_key, mime, bytes, sha256) VALUES ($1,$2,'document',$3,$4,$5,$6,$7) RETURNING id`, [req.user!.id, card.id, caption || file.filename, key, mime, bytes.length, sha256(bytes)]);
      return { id: r.rows[0].id };
    }

    let ing;
    try {
      ing = await ingestImage(buf, ctx.cfg.maxImagePixels);
    } catch (e) {
      return bad(reply, (e as Error).message.includes('Unsupported') ? (e as Error).message : 'Could not decode image.');
    }
    const id = await tx(db, async (c) => {
      if (kind === 'front' || kind === 'back') {
        // A new front/back supersedes the previous one; originals are kept immutable.
        await c.query(`UPDATE assets SET superseded=true WHERE card_id=$1 AND kind=$2 AND NOT superseded`, [card.id, kind]);
      }
      const origKey = await ctx.store.put(buf, ing.originalMime === 'image/png' ? 'png' : ing.originalMime === 'image/heic' ? 'heic' : 'jpg');
      const orig = await c.query(
        `INSERT INTO assets (user_id, card_id, kind, label, storage_key, mime, bytes, sha256, width, height) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [req.user!.id, card.id, kind, caption || null, origKey, ing.originalMime, buf.length, hash, ing.quality.width, ing.quality.height],
      );
      const copyKey = await ctx.store.put(ing.analysisJpeg, 'jpg');
      await c.query(
        `INSERT INTO assets (user_id, card_id, kind, parent_asset_id, label, storage_key, mime, bytes, sha256, width, height, quality) VALUES ($1,$2,'analysis_copy',$3,$4,$5,'image/jpeg',$6,$7,$8,$9,$10)`,
        [req.user!.id, card.id, orig.rows[0].id, kind, copyKey, ing.analysisJpeg.length, sha256(ing.analysisJpeg), ing.quality.width, ing.quality.height, JSON.stringify(ing.quality)],
      );
      return orig.rows[0].id as string;
    });
    await audit(db, req.user!.id, card.id, 'asset_uploaded', { asset_id: id, kind, sha256: hash });
    return { id, quality: ing.quality };
  });

  app.get('/api/assets/:id', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as any).id;
    if (!uuid.safeParse(id).success) return bad(reply, 'not_found', 404);
    const a = (await db.query('SELECT storage_key, mime FROM assets WHERE id=$1 AND user_id=$2', [id, req.user!.id])).rows[0];
    if (!a) return bad(reply, 'not_found', 404);
    // HEIC originals are not browser-renderable; serve the analysis copy instead.
    let key = a.storage_key;
    let mime = a.mime;
    if (mime === 'image/heic') {
      const c = (await db.query(`SELECT storage_key FROM assets WHERE parent_asset_id=$1 AND kind='analysis_copy' LIMIT 1`, [id])).rows[0];
      if (c) { key = c.storage_key; mime = 'image/jpeg'; }
    }
    reply.header('cache-control', 'private, max-age=300').header('x-content-type-options', 'nosniff').type(mime);
    if (mime === 'application/pdf') reply.header('content-disposition', 'attachment');
    return reply.send(await ctx.store.get(key));
  });

  // ---------------- analysis ----------------
  app.post('/api/cards/:id/analyze', { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const imgs = (await db.query(`SELECT kind, sha256 FROM assets WHERE card_id=$1 AND kind IN ('front','back') AND NOT superseded`, [card.id])).rows;
    const front = imgs.find((i) => i.kind === 'front');
    const back = imgs.find((i) => i.kind === 'back');
    if (!front || !back) {
      await db.query(`UPDATE card_instances SET analysis_state='needs_photos' WHERE id=$1`, [card.id]);
      return bad(reply, 'Both a front and a back photo are required.', 422);
    }
    const details = (await db.query(`SELECT sha256 FROM assets WHERE card_id=$1 AND kind='detail' ORDER BY created_at`, [card.id])).rows.map((r) => r.sha256.slice(0, 12)).join(',');
    const key = `${card.id}:extract:${front.sha256}:${back.sha256}:${details}`;
    const j = await enqueue(db, { cardId: card.id, userId: req.user!.id, kind: 'extract', payload: {}, idempotencyKey: key });
    if (j.created) await db.query(`UPDATE card_instances SET analysis_state='analyzing', updated_at=now() WHERE id=$1`, [card.id]);
    ctx.kick();
    return { jobId: j.id, reused: !j.created };
  });

  app.post('/api/cards/:id/retry', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const j = (await db.query(`SELECT id, kind FROM analysis_jobs WHERE card_id=$1 AND state='failed' ORDER BY updated_at DESC LIMIT 1`, [card.id])).rows[0];
    if (!j) return bad(reply, 'Nothing to retry.', 409);
    await requeue(db, j.id);
    await db.query(`UPDATE card_instances SET analysis_state=$2, updated_at=now() WHERE id=$1`, [card.id, j.kind === 'extract' ? 'analyzing' : 'retrieving_sales']);
    await audit(db, req.user!.id, card.id, 'job_retry', { job_id: j.id });
    ctx.kick();
    return { jobId: j.id };
  });

  // Confirm or correct the identity (Screen B).
  const IdentityBody = z.object({
    basedOnVersionId: uuid,
    corrections: z.array(z.object({ name: z.enum(IDENTITY_FIELD_NAMES), value: z.string().max(500).nullable() })).max(80).default([]),
    chosenCandidate: z.number().int().min(0).nullable().optional(),
    rawOrGraded: z.enum(['raw', 'graded']).nullable().optional(),
  });
  app.post('/api/cards/:id/identity', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const p = IdentityBody.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues[0]?.message ?? 'invalid');
    const base = (await db.query('SELECT * FROM identity_versions WHERE id=$1 AND card_id=$2', [p.data.basedOnVersionId, card.id])).rows[0];
    if (!base) return bad(reply, 'Unknown identity version', 404);
    if (base.id !== card.current_identity_version_id) return bad(reply, 'Identity changed since you loaded it; reload and try again.', 409);
    let corrections = p.data.corrections;
    if (p.data.chosenCandidate != null) {
      const cand = (base.candidates ?? [])[p.data.chosenCandidate];
      if (!cand) return bad(reply, 'Unknown candidate');
      corrections = [...cand.differences.map((d: any) => ({ name: d.name, value: d.value })), ...corrections];
    }
    const { fields, diff } = applyCorrections(base.fields as IdentityFields, corrections);
    const source = diff.length ? 'user_correction' : 'user_confirmation';
    const result = await tx(db, async (c) => {
      const v = (await c.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM identity_versions WHERE card_id=$1', [card.id])).rows[0].v;
      const iv = await c.query(
        `INSERT INTO identity_versions (card_id, version, source, based_on_version_id, extraction_id, fields, candidates, conflicts, ai_suggestion, correction_diff, confirmed, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'[]',$7,$8,$9,true,$10) RETURNING id`,
        [card.id, v, source, base.id, base.extraction_id, JSON.stringify(fields), JSON.stringify(Object.entries(fields).filter(([, f]) => f?.status === 'conflicting').map(([k]) => k)), JSON.stringify(base.ai_suggestion), JSON.stringify(diff), req.user!.id],
      );
      const newId = iv.rows[0].id;
      if (p.data.rawOrGraded !== undefined) await c.query('UPDATE card_instances SET raw_or_graded=$2 WHERE id=$1', [card.id, p.data.rawOrGraded]);
      await c.query('UPDATE card_instances SET current_identity_version_id=$2, title=$3, updated_at=now() WHERE id=$1', [card.id, newId, identityLabel(fields)]);
      await c.query('INSERT INTO audit_events (user_id, card_id, kind, payload) VALUES ($1,$2,$3,$4)', [req.user!.id, card.id, source, JSON.stringify({ from_version: base.id, to_version: newId, diff })]);
      const pending = (await c.query(`SELECT count(*)::int AS n FROM questions WHERE card_id=$1 AND answer_status='pending'`, [card.id])).rows[0].n;
      return { newId, pending };
    });
    // A correction always requires fresh comps: prior reports stay tied to the old identity version.
    if (result.pending > 0) {
      await db.query(`UPDATE card_instances SET analysis_state='needs_answers' WHERE id=$1`, [card.id]);
      return { identityVersionId: result.newId, next: 'needs_answers' };
    }
    const j = await enqueue(db, { cardId: card.id, userId: req.user!.id, kind: 'value', payload: { identityVersionId: result.newId }, idempotencyKey: `${card.id}:value:${result.newId}:initial` });
    await db.query(`UPDATE card_instances SET analysis_state='retrieving_sales' WHERE id=$1`, [card.id]);
    ctx.kick();
    return { identityVersionId: result.newId, next: 'retrieving_sales', jobId: j.id };
  });

  // Targeted questions (Screen C).
  const Answers = z.object({ answers: z.array(z.object({ id: uuid, status: z.enum(['answered', 'unknown', 'skipped']), answer: z.string().max(1000).nullable().optional() })).max(20) });
  app.post('/api/cards/:id/answers', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const p = Answers.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues[0]?.message ?? 'invalid');
    const out = await tx(db, async (c) => {
      const fieldAnswers: { name: any; value: string }[] = [];
      for (const a of p.data.answers) {
        const q = (await c.query('SELECT * FROM questions WHERE id=$1 AND card_id=$2', [a.id, card.id])).rows[0];
        if (!q) continue;
        const answer = a.status === 'answered' ? (a.answer ?? '').trim() || null : null;
        await c.query('UPDATE questions SET answer=$2, answer_status=$3, answered_at=now() WHERE id=$1', [q.id, answer, answer ? 'answered' : a.status === 'answered' ? 'skipped' : a.status]);
        if (answer && q.field && (IDENTITY_FIELD_NAMES as readonly string[]).includes(q.field)) fieldAnswers.push({ name: q.field, value: answer });
        if (answer) await c.query(`INSERT INTO provenance_claims (card_id, user_id, kind, statement) VALUES ($1,$2,'question_answer',$3)`, [card.id, req.user!.id, `${q.text} — ${answer}`]);
      }
      let ivId = card.current_identity_version_id;
      if (fieldAnswers.length && ivId) {
        const base = (await c.query('SELECT * FROM identity_versions WHERE id=$1', [ivId])).rows[0];
        const { fields, diff } = applyCorrections(base.fields, fieldAnswers);
        if (diff.length) {
          const v = (await c.query('SELECT COALESCE(MAX(version),0)+1 AS v FROM identity_versions WHERE card_id=$1', [card.id])).rows[0].v;
          ivId = (
            await c.query(
              `INSERT INTO identity_versions (card_id, version, source, based_on_version_id, extraction_id, fields, candidates, conflicts, ai_suggestion, correction_diff, confirmed, created_by)
               VALUES ($1,$2,'owner_answers',$3,$4,$5,'[]','[]',$6,$7,$8,$9) RETURNING id`,
              [card.id, v, base.id, base.extraction_id, JSON.stringify(fields), JSON.stringify(base.ai_suggestion), JSON.stringify(diff), base.confirmed, req.user!.id],
            )
          ).rows[0].id;
          await c.query('UPDATE card_instances SET current_identity_version_id=$2, title=$3 WHERE id=$1', [card.id, ivId, identityLabel(fields)]);
        }
      }
      await c.query('INSERT INTO audit_events (user_id, card_id, kind, payload) VALUES ($1,$2,$3,$4)', [req.user!.id, card.id, 'questions_answered', JSON.stringify({ count: p.data.answers.length })]);
      const pending = (await c.query(`SELECT count(*)::int AS n FROM questions WHERE card_id=$1 AND answer_status='pending'`, [card.id])).rows[0].n;
      const confirmed = ivId ? (await c.query('SELECT confirmed FROM identity_versions WHERE id=$1', [ivId])).rows[0].confirmed : false;
      return { pending, ivId, confirmed };
    });
    if (out.pending === 0 && out.confirmed && out.ivId) {
      const j = await enqueue(db, { cardId: card.id, userId: req.user!.id, kind: 'value', payload: { identityVersionId: out.ivId }, idempotencyKey: `${card.id}:value:${out.ivId}:initial` });
      await db.query(`UPDATE card_instances SET analysis_state='retrieving_sales' WHERE id=$1`, [card.id]);
      ctx.kick();
      return { next: 'retrieving_sales', jobId: j.id };
    }
    return { next: out.pending ? 'needs_answers' : 'needs_identification' };
  });

  // Provenance and notes.
  const Prov = z.object({ kind: z.enum(['acquisition', 'signing', 'receipt', 'certificate', 'previous_listing', 'other']), statement: z.string().min(1).max(4000), documentAssetIds: z.array(uuid).max(10).default([]) });
  app.post('/api/cards/:id/provenance', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const p = Prov.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues[0]?.message ?? 'invalid');
    if (p.data.documentAssetIds.length) {
      const ok = await db.query(`SELECT count(*)::int AS n FROM assets WHERE id = ANY($1::uuid[]) AND card_id=$2 AND kind='document'`, [p.data.documentAssetIds, card.id]);
      if (ok.rows[0].n !== p.data.documentAssetIds.length) return bad(reply, 'Unknown document');
    }
    const r = await db.query(`INSERT INTO provenance_claims (card_id, user_id, kind, statement, document_asset_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [card.id, req.user!.id, p.data.kind, p.data.statement, JSON.stringify(p.data.documentAssetIds)]);
    await audit(db, req.user!.id, card.id, 'provenance_added', { id: r.rows[0].id, kind: p.data.kind });
    return { id: r.rows[0].id, verificationStatus: 'owner_reported' };
  });

  app.post('/api/cards/:id/observations/:obsId', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const p = z.object({ bbox: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).nullable() }).safeParse(req.body);
    if (!p.success || !uuid.safeParse((req.params as any).obsId).success) return bad(reply, 'invalid');
    const r = await db.query('UPDATE observations SET user_bbox=$3 WHERE id=$1 AND card_id=$2', [(req.params as any).obsId, card.id, p.data.bbox ? JSON.stringify(p.data.bbox) : null]);
    if (!r.rowCount) return bad(reply, 'not_found', 404);
    await audit(db, req.user!.id, card.id, 'observation_location_corrected', { observation_id: (req.params as any).obsId, bbox: p.data.bbox });
    return { ok: true };
  });

  // Owner-supplied comparable evidence (permitted evidence import).
  const OwnerComp = z.object({
    url: z.string().url().max(1000).refine((u) => /^https?:\/\//i.test(u), 'http(s) URL required'),
    marketplace: z.string().min(1).max(80),
    sourceRecordId: z.string().max(120).nullable().optional(),
    saleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    title: z.string().min(1).max(300),
    amount: z.number().positive().max(100_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    priceBasis: z.enum(['item_price', 'hammer', 'hammer_plus_premium', 'total_including_shipping', 'unknown']),
    saleFormat: z.enum(['auction', 'fixed_price', 'best_offer', 'marketplace_auction', 'private', 'unknown']),
    sameCardConfirmed: z.boolean(),
    grade: z.object({ state: z.enum(['raw', 'graded']), grader: z.enum(GRADERS).nullable(), cardGrade: z.string().max(20).nullable(), autographGrade: z.string().max(20).nullable(), qualifiers: z.array(z.string().max(40)).max(5).default([]) }),
    rawConditionBand: z.enum(['appears_well_preserved', 'minor_wear_visible', 'moderate_wear_visible', 'heavy_wear_or_damage', 'not_assessable']).nullable().optional(),
    certNumber: z.string().max(30).nullable().optional(),
    serialNumber: z.string().max(30).nullable().optional(),
    buyerPremiumAmount: z.number().nonnegative().nullable().optional(),
    shippingAmount: z.number().nonnegative().nullable().optional(),
    taxAmount: z.number().nonnegative().nullable().optional(),
  });
  app.post('/api/cards/:id/comps', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const p = OwnerComp.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues[0]?.message ?? 'invalid');
    const d = p.data;
    const iv = (await db.query('SELECT fields FROM identity_versions WHERE id=$1', [card.current_identity_version_id])).rows[0];
    if (!iv) return bad(reply, 'Identify the card before adding comparable sales.', 409);
    const toMinor = (x: number | null | undefined) => (x == null ? null : Math.round(x * (['JPY', 'KRW'].includes(d.currency) ? 1 : 100)));
    // The owner asserts the sale is the same card; mapped identity copies the current identity, but the record
    // stays labeled owner_supplied and is never treated as independently verified.
    const mapped = d.sameCardConfirmed ? Object.fromEntries(Object.entries(iv.fields as IdentityFields).map(([k, f]) => [k, f?.value ?? null])) : {};
    const rec: SaleRecordInput = {
      provider: 'owner_supplied', originMarketplace: d.marketplace, sourceRecordId: d.sourceRecordId ?? null, canonicalUrl: d.url, acquisitionMethod: 'owner_supplied',
      retrievedAt: new Date().toISOString(), snapshotHash: null, evidenceExcerpt: null, isFixture: false, saleDate: d.saleDate, saleDatePrecision: 'day',
      saleStatus: 'sold', paymentStatus: 'unknown', canceled: false, returned: false, relisted: false, saleFormat: d.saleFormat, quantity: 1, isLot: false, lotAllocationTrusted: false,
      originalTitle: d.title, mappedIdentity: mapped, identityEvidenceNote: d.sameCardConfirmed ? 'Owner asserted same card' : 'Owner did not confirm same card',
      grade: d.grade, conditionEvidence: d.grade.state === 'graded' ? 'adequate' : d.rawConditionBand ? 'limited' : 'insufficient', rawConditionBand: d.rawConditionBand ?? null,
      serialNumber: d.serialNumber ?? null, certNumber: d.certNumber ?? null, alteredOrReproduction: false, currency: d.currency, reportedAmountMinor: toMinor(d.amount),
      priceBasis: d.priceBasis, buyerPremiumMinor: toMinor(d.buyerPremiumAmount), buyerPremiumRate: null, buyerPremiumEvidence: d.buyerPremiumAmount != null ? 'Owner-entered premium amount' : null,
      shippingMinor: toMinor(d.shippingAmount), taxMinor: toMinor(d.taxAmount), acceptedOffer: d.saleFormat === 'best_offer', acceptedAmountKnown: true, recordQuality: 'feed_complete_fields',
    };
    const evidenceId = newEvidenceId();
    await db.query(
      `INSERT INTO sales_records (evidence_id, user_id, card_id, provider, origin_marketplace, source_record_id, canonical_url, acquisition_method, is_fixture, retrieved_at, record)
       VALUES ($1,$2,$3,'owner_supplied',$4,$5,$6,'owner_supplied',false,now(),$7)`,
      [evidenceId, req.user!.id, card.id, d.marketplace, d.sourceRecordId ?? null, d.url, JSON.stringify(rec)],
    );
    await audit(db, req.user!.id, card.id, 'owner_comp_added', { evidence_id: evidenceId });
    return { evidenceId };
  });

  app.post('/api/cards/:id/comps/:evidenceId/flag', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const p = z.object({ action: z.enum(['exclude_next_run', 'report_mistake']), reason: z.string().min(1).max(1000) }).safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues[0]?.message ?? 'invalid');
    const ev = (req.params as any).evidenceId;
    const exists = await db.query('SELECT 1 FROM sales_records WHERE evidence_id=$1 AND card_id=$2', [ev, card.id]);
    if (!exists.rowCount) return bad(reply, 'not_found', 404);
    await db.query('INSERT INTO comp_flags (card_id, user_id, evidence_id, action, reason) VALUES ($1,$2,$3,$4,$5)', [card.id, req.user!.id, ev, p.data.action, p.data.reason]);
    await audit(db, req.user!.id, card.id, 'comp_flagged', { evidence_id: ev, ...p.data });
    return { ok: true, note: 'Logged. Flags can exclude a record from future runs; they never mark evidence as verified.' };
  });

  app.post('/api/cards/:id/revalue', { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card) return bad(reply, 'not_found', 404);
    const iv = (await db.query('SELECT id, confirmed FROM identity_versions WHERE id=$1', [card.current_identity_version_id])).rows[0];
    if (!iv?.confirmed) return bad(reply, 'Confirm the identity first.', 409);
    const nonce = (req.headers['idempotency-key'] as string | undefined)?.slice(0, 80) ?? `${Date.now()}`;
    const j = await enqueue(db, { cardId: card.id, userId: req.user!.id, kind: 'value', payload: { identityVersionId: iv.id }, idempotencyKey: `${card.id}:value:${iv.id}:${nonce}` });
    await db.query(`UPDATE card_instances SET analysis_state='retrieving_sales' WHERE id=$1`, [card.id]);
    ctx.kick();
    return { jobId: j.id };
  });

  // ---------------- reports & export ----------------
  app.get('/api/cards/:id/reports/:runId', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card || !uuid.safeParse((req.params as any).runId).success) return bad(reply, 'not_found', 404);
    const rep = await buildReport(ctx, card, (req.params as any).runId);
    if (!rep) return bad(reply, 'not_found', 404);
    return rep;
  });

  app.get('/api/cards/:id/reports/:runId/print', { preHandler: auth }, async (req, reply) => {
    const card = await ownedCard(req.user!.id, (req.params as any).id);
    if (!card || !uuid.safeParse((req.params as any).runId).success) return bad(reply, 'not_found', 404);
    const rep = await buildReport(ctx, card, (req.params as any).runId);
    if (!rep) return bad(reply, 'not_found', 404);
    reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'").type('text/html');
    return printableReport(rep);
  });

  app.get('/api/export.csv', { preHandler: auth }, async (req, reply) => {
    const csv = await collectionCsv(ctx, req.user!.id);
    reply.header('content-disposition', 'attachment; filename="collection.csv"').type('text/csv; charset=utf-8');
    return csv;
  });
}

const STALE_DAYS = 90;
export function collectionTotals(rows: any[]) {
  const t = { supportedMinor: 0, supportedCount: 0, conditionalCount: 0, staleCount: 0, missingCount: 0, limitedCount: 0, fixtureCount: 0, currencyMixed: false, currency: rows[0]?.currency ?? 'USD' };
  for (const r of rows) {
    if (r.currency !== t.currency) t.currencyMixed = true;
    const h = r.headline;
    if (!h) { t.missingCount++; continue; }
    if (r.fixture) { t.fixtureCount++; continue; }
    const stale = r.valued_at && (Date.now() - new Date(r.valued_at).getTime()) / 86_400_000 > STALE_DAYS;
    if (h.kind === 'conditional' || h.kind === 'suppressed') t.conditionalCount++;
    else if (h.centralMinor == null) t.limitedCount++;
    else if (stale) t.staleCount++;
    else if (r.currency === t.currency) { t.supportedMinor += h.centralMinor; t.supportedCount++; }
  }
  return t;
}
