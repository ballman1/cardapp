// @ts-check
// Card Evidence — single-page client. No build step; DOM is built with createElement
// (never innerHTML with data) so listing/owner text cannot inject markup.

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const nav = /** @type {HTMLElement} */ (document.getElementById('nav'));
let me = null;
let pollTimer = 0;

// ---------------------------------------------------------------- helpers
/** @param {string} tag @param {Record<string, any>|null} [attrs] @param {...any} kids */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'x-requested-with': 'cardvalue', ...(opts.headers || {}) }, credentials: 'same-origin' };
  if (opts.json !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
  if (opts.form) init.body = opts.form;
  const res = await fetch(path, init);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth')) { location.hash = '#/login'; }
    throw new Error((body && body.error) || `HTTP ${res.status}`);
  }
  return body;
}

const fmt = (minor, cur) => (minor == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 0 }).format(minor / 100));
const label = (s) => String(s ?? '').replace(/_/g, ' ');
const STATE_TEXT = {
  needs_photos: ['Needs photos', 'warn'], analyzing: ['Analyzing photos', ''], needs_identification: ['Confirm identity', 'warn'],
  needs_answers: ['Questions waiting', 'warn'], retrieving_sales: ['Retrieving sales', ''], ready: ['Ready', 'ok'],
  limited_evidence: ['Limited evidence', 'warn'], conditional: ['Conditional', 'warn'], failed_retryable: ['Failed — retry', 'bad'],
};
const stateChip = (s) => h('span', { class: `chip ${(STATE_TEXT[s] || [])[1] || ''}` }, (STATE_TEXT[s] || [label(s)])[0]);
const statusChip = (s) => h('span', { class: `chip ${['observed', 'catalog_matched', 'provider_verified', 'record_matches'].includes(s) ? 'ok' : ['conflicting', 'record_mismatch', 'record_not_found'].includes(s) ? 'bad' : 'warn'}` }, label(s));
const errBox = () => h('p', { class: 'err', role: 'alert', 'aria-live': 'assertive' });
async function guarded(btn, errEl, fn) {
  btn.disabled = true; errEl.textContent = '';
  try { await fn(); } catch (e) { errEl.textContent = e.message; } finally { btn.disabled = false; }
}
function render(...nodes) { clearInterval(pollTimer); app.replaceChildren(...nodes); app.focus(); }

// ---------------------------------------------------------------- routing
async function route() {
  const hash = location.hash || '#/';
  if (!me && hash !== '#/login') {
    try { me = await api('/api/auth/me'); } catch { location.hash = '#/login'; return; }
  }
  renderNav();
  const m = hash.match(/^#\/card\/([0-9a-f-]{36})(?:\/report\/([0-9a-f-]{36}))?$/);
  try {
    if (hash === '#/login') return viewLogin();
    if (hash === '#/new') return viewNew();
    if (hash === '#/connectors') return viewConnectors();
    if (m && m[2]) return viewReport(m[1], m[2]);
    if (m) return viewCard(m[1]);
    return viewCollection();
  } catch (e) { render(h('p', { class: 'err' }, e.message)); }
}
window.addEventListener('hashchange', route);

function renderNav() {
  nav.replaceChildren(...(me ? [
    h('a', { href: '#/' }, 'Collection'), h('a', { href: '#/new' }, 'Add card'), h('a', { href: '#/connectors' }, 'Sources'),
    h('a', { href: '#/login', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); me = null; } }, 'Sign out'),
  ] : []));
  if (me) api('/api/connectors').then((c) => document.getElementById('fixture-banner')?.classList.toggle('hidden', !c.fixturesEnabled)).catch(() => {});
}

// ---------------------------------------------------------------- login
function viewLogin() {
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true });
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', minlength: 10, required: true });
  const err = errBox();
  const go = (path) => async (ev) => {
    ev.preventDefault();
    await guarded(ev.submitter || ev.target, err, async () => {
      me = await api(path, { method: 'POST', json: { email: email.value, password: pw.value } });
      location.hash = '#/';
    });
  };
  const regBtn = h('button', { class: 'btn', type: 'button', onclick: (e) => go('/api/auth/register')({ preventDefault() {}, target: e.target }) }, 'Create account');
  render(h('div', { class: 'panel' },
    h('h1', null, 'Sign in'),
    h('form', { onsubmit: go('/api/auth/login') },
      h('label', { for: 'email' }, 'Email'), email,
      h('label', { for: 'pw' }, 'Password (10+ characters)'), pw,
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'), regBtn), err)));
}

// ---------------------------------------------------------------- collection (Screen F)
async function viewCollection() {
  const data = await api('/api/cards');
  const t = data.totals;
  const tiles = data.cards.map((c) => {
    const hd = c.headline;
    let val = 'Not valued';
    if (hd) val = hd.display.central != null ? fmt(hd.display.central, c.currency) : hd.display.low != null ? `${fmt(hd.display.low, c.currency)}–${fmt(hd.display.high, c.currency)}` : label(hd.kind);
    return h('a', { class: 'cardtile', href: `#/card/${c.id}` },
      c.thumb ? h('img', { src: `/api/assets/${c.thumb}`, alt: '' }) : h('div', { class: 'thumb-ph' }),
      h('div', { class: 'grow' }, h('div', null, h('b', null, c.title || 'Untitled card')), h('div', null, stateChip(c.analysis_state)),
        h('div', { class: 'small' }, val, c.fixture ? h('span', { class: 'chip bad' }, ' FIXTURE') : null, hd && hd.centralMinor == null && hd.kind !== 'insufficient' ? '' : ''),
        c.valued_at ? h('div', { class: 'small muted' }, `Valued ${new Date(c.valued_at).toLocaleDateString()}`) : null));
  });
  render(
    h('h1', null, 'Collection'),
    h('div', { class: 'panel' },
      h('div', { class: 'value' }, fmt(t.supportedMinor, t.currency)),
      h('div', { class: 'muted small' }, `Sum of ${t.supportedCount} current supported central estimate(s). Not included: ${t.limitedCount} limited/insufficient, ${t.conditionalCount} conditional, ${t.staleCount} stale (>90 days), ${t.missingCount} not valued${t.fixtureCount ? `, ${t.fixtureCount} fixture` : ''}.${t.currencyMixed ? ' Cards in other currencies are excluded from this total.' : ''}`),
      h('div', { class: 'btns' }, h('a', { class: 'btn primary', href: '#/new' }, 'Add a card'), h('a', { class: 'btn', href: '/api/export.csv' }, 'Export CSV'))),
    tiles.length ? h('div', { class: 'cards' }, tiles) : h('p', { class: 'muted' }, 'No cards yet.'));
}

// ---------------------------------------------------------------- new card (Screen A)
const CAPTURE_TIPS = ['All four corners visible', 'Plain, contrasting background', 'Camera parallel to the card', 'Soft, diffuse light — no glare', 'No filters; original resolution', 'Keep slabbed cards in their slab'];

function photoInput(kind, title, onFile) {
  const id = `f-${kind}-${Math.random().toString(36).slice(2, 7)}`;
  const preview = h('div');
  const input = h('input', { type: 'file', id, accept: 'image/jpeg,image/png,image/heic,image/heif,.heic,.heif', capture: 'environment', onchange: () => {
    const f = input.files && input.files[0];
    if (!f) return;
    preview.replaceChildren(/heic|heif/i.test(f.type + f.name) ? h('p', { class: 'small muted' }, `${f.name} (HEIC — converted on upload)`) : h('img', { src: URL.createObjectURL(f), alt: `${title} preview` }));
    onFile(f);
  } });
  return h('div', { class: 'dropzone grow' }, h('label', { for: id }, title), input, preview);
}

function viewNew() {
  const files = { front: null, back: null };
  const err = errBox();
  const sel = (id, opts) => h('select', { id }, opts.map(([v, t]) => h('option', { value: v }, t)));
  const cat = sel('cat', [['', 'Detect automatically'], ['baseball', 'Baseball'], ['football', 'Football'], ['basketball', 'Basketball'], ['hockey', 'Hockey'], ['pokemon', 'Pokémon']]);
  const rg = sel('rg', [['', 'Not sure'], ['raw', 'Raw (ungraded)'], ['graded', 'Graded slab']]);
  const own = sel('own', [['owned', 'I own it'], ['consigned', 'Consigned to me'], ['considering_purchase', 'Considering buying'], ['other', 'Other']]);
  const cur = h('input', { id: 'cur', value: 'USD', maxlength: 3, pattern: '[A-Z]{3}' });
  const notes = h('textarea', { id: 'notes', placeholder: 'Anything that might help: where it came from, known issues, signing details…' });
  const btn = h('button', { class: 'btn primary', type: 'button', onclick: () => guarded(btn, err, async () => {
    if (!files.front || !files.back) throw new Error('Both a front and a back photo are required.');
    const c = await api('/api/cards', { method: 'POST', json: { categoryHint: cat.value || null, rawOrGraded: rg.value || null, ownershipStatus: own.value, currency: cur.value.toUpperCase() || 'USD', ownerNotes: notes.value } });
    for (const k of ['front', 'back']) await upload(c.id, k, files[k]);
    await api(`/api/cards/${c.id}/analyze`, { method: 'POST' });
    location.hash = `#/card/${c.id}`;
  }) }, 'Upload and analyze');
  render(
    h('h1', null, 'Add a card'),
    h('div', { class: 'panel' }, h('h2', null, 'Photo tips'), h('ul', null, CAPTURE_TIPS.map((t) => h('li', null, t))), h('p', { class: 'small muted' }, 'One card per analysis. Do not remove a valuable card from its slab or handle a fragile card just for photos.')),
    h('div', { class: 'panel' }, h('div', { class: 'row' }, photoInput('front', 'Front photo (required)', (f) => (files.front = f)), photoInput('back', 'Back photo (required)', (f) => (files.back = f)))),
    h('div', { class: 'panel' }, h('h2', null, 'Options'),
      h('div', { class: 'grid2' }, h('div', null, h('label', { for: 'cat' }, 'Category'), cat), h('div', null, h('label', { for: 'rg' }, 'Raw or graded'), rg), h('div', null, h('label', { for: 'own' }, 'Ownership'), own), h('div', null, h('label', { for: 'cur' }, 'Valuation currency'), cur)),
      h('p', { class: 'small muted' }, 'Value basis: estimated ordinary resale value (buyer price before shipping and tax). Insurance, tax and formal appraisals are different products.'),
      h('label', { for: 'notes' }, 'Additional information (optional)'), notes,
      h('div', { class: 'btns' }, btn), err));
}

async function upload(cardId, kind, file, caption) {
  const fd = new FormData();
  fd.append('kind', kind);
  if (caption) fd.append('caption', caption);
  fd.append('file', file);
  return api(`/api/cards/${cardId}/assets`, { method: 'POST', form: fd });
}

// ---------------------------------------------------------------- card workflow
async function viewCard(id) {
  const d = await api(`/api/cards/${id}`);
  const c = d.card;
  const cur = d.versions.find((v) => v.id === c.current_identity_version_id);
  const imgs = currentImages(d);
  const header = h('div', null, h('h1', null, c.title || 'New card'), h('p', null, stateChip(c.analysis_state), ' ', h('span', { class: 'muted small' }, cur ? `Identity v${cur.version} (${label(cur.source)})${cur.confirmed ? ', confirmed' : ''}` : '')));
  const parts = [header];
  const working = ['analyzing', 'retrieving_sales'].includes(c.analysis_state);

  if (working) {
    const job = d.jobs[0];
    parts.push(h('div', { class: 'panel', 'aria-live': 'polite' }, h('span', { class: 'spinner' }), c.analysis_state === 'analyzing' ? 'Reading the photos and identifying the card…' : 'Checking certification, retrieving permitted sales and calculating…', job?.stage ? h('div', { class: 'small muted' }, `Stage: ${label(job.stage)}${job.attempts > 1 ? ` (attempt ${job.attempts})` : ''}`) : null, job?.last_error ? h('div', { class: 'small err' }, `Last error: ${job.last_error_code}`) : null));
  }
  if (c.analysis_state === 'failed_retryable') {
    const job = d.jobs.find((j) => j.state === 'failed');
    const err = errBox();
    const b = h('button', { class: 'btn primary', onclick: () => guarded(b, err, async () => { await api(`/api/cards/${id}/retry`, { method: 'POST' }); route(); }) }, 'Retry');
    parts.push(h('div', { class: 'panel' }, h('h2', null, 'The analysis stopped'), h('p', { class: 'err' }, job ? `${job.last_error_code}: ${job.last_error}` : 'Unknown error'), h('p', { class: 'small muted' }, 'Completed stages are kept; a retry resumes from the failed stage.'), b, err));
  }

  parts.push(photosPanel(d, imgs, id));
  if (d.extraction && ['needs_identification', 'needs_answers', 'ready', 'limited_evidence', 'conditional', 'needs_photos'].includes(c.analysis_state)) {
    parts.push(qualityPanel(d));
    parts.push(identityPanel(d, cur, id));
  }
  if (d.questions.some((q) => q.answer_status === 'pending')) parts.push(questionsPanel(d, id));
  if (d.extraction) parts.push(conditionPanel(d, imgs));
  parts.push(notesPanel(d, id));
  if (d.runs.length) parts.push(runsPanel(d, id));
  if (cur?.confirmed) parts.push(ownerCompPanel(d, id));
  parts.push(dangerPanel(id));
  render(...parts);
  if (d.runs.length && ['ready', 'limited_evidence', 'conditional'].includes(c.analysis_state) && !working) {
    // Show the latest report inline below the header.
    const rep = await api(`/api/cards/${id}/reports/${d.runs[0].id}`);
    app.insertBefore(reportView(rep, id, d), app.children[1] || null);
  }
  if (working) pollTimer = window.setInterval(async () => {
    const s = await api(`/api/cards/${id}`).catch(() => null);
    if (s && s.card.analysis_state !== c.analysis_state) route();
  }, 2500);
}

function currentImages(d) {
  const originals = d.assets.filter((a) => ['front', 'back'].includes(a.kind) && !a.superseded);
  const copies = d.assets.filter((a) => a.kind === 'analysis_copy');
  const get = (k) => { const o = originals.filter((a) => a.kind === k).at(-1); return o ? { original: o, copy: copies.find((c) => c.parent_asset_id === o.id) } : null; };
  return { front: get('front'), back: get('back'), crops: d.assets.filter((a) => a.kind === 'crop'), details: d.assets.filter((a) => a.kind === 'detail') };
}

function photosPanel(d, imgs, id) {
  const err = errBox();
  const pending = {};
  const reBtn = h('button', { class: 'btn primary', onclick: () => guarded(reBtn, err, async () => {
    for (const [k, f] of Object.entries(pending)) await upload(id, k === 'detail' ? 'detail' : k, f, k === 'detail' ? detailCap.value : undefined);
    await api(`/api/cards/${id}/analyze`, { method: 'POST' });
    route();
  }) }, d.extraction ? 'Upload and re-analyze' : 'Analyze');
  const detailCap = h('input', { id: 'detail-cap', placeholder: 'What does the close-up show? (e.g. serial stamp)' });
  const x = d.extraction?.output;
  const msgs = [];
  if (x?.multiple_cards_detected || x?.images_show_single_card === false) msgs.push('More than one card appears in the photos. Photograph one card per analysis.');
  if (x?.front_back_consistency === 'inconsistent') msgs.push('The front and back appear to be from different cards. Please confirm or retake.');
  if (x?.front_back_consistency === 'back_missing') msgs.push('The back of the card is missing or unreadable.');
  const show = d.card.analysis_state === 'needs_photos' || msgs.length;
  const imgCell = (im, t) => h('div', { class: 'photo' }, im?.copy ? h('img', { src: `/api/assets/${im.copy.id}`, alt: `${t} of card` }) : h('div', { class: 'thumb-ph' }), h('div', { class: 'small muted' }, t));
  return h('div', { class: 'panel' },
    h('h2', null, 'Photos'),
    h('div', { class: 'photos' }, imgCell(imgs.front, 'Front'), imgCell(imgs.back, 'Back'), imgs.details.map((dt) => h('div', { class: 'photo' }, h('img', { src: `/api/assets/${dt.id}`, alt: dt.label || 'detail' }), h('div', { class: 'small muted' }, `Detail: ${dt.label || ''}`)))),
    msgs.map((m) => h('p', { class: 'err' }, m)),
    h('details', { open: !!show }, h('summary', null, 'Replace photos or add a close-up'),
      h('div', { class: 'row' }, photoInput('front', 'New front', (f) => (pending.front = f)), photoInput('back', 'New back', (f) => (pending.back = f)), photoInput('detail', 'Close-up / angled-light detail', (f) => (pending.detail = f))),
      h('label', { for: 'detail-cap' }, 'Close-up caption'), detailCap,
      h('p', { class: 'small muted' }, 'Original files are kept unchanged. New photos start a new analysis; earlier reports stay available.'),
      h('div', { class: 'btns' }, reBtn), err));
}

function qualityPanel(d) {
  const issues = [];
  for (const a of d.assets.filter((x) => x.kind === 'analysis_copy' && x.quality)) for (const i of a.quality.issues || []) issues.push(`${a.label}: ${i.detail}`);
  for (const i of d.extraction.output.image_quality_issues || []) issues.push(`${i.image}: ${label(i.issue)} — ${i.detail}`);
  const req = d.extraction.output.requested_photos || [];
  if (!issues.length && !req.length) return h('span');
  return h('div', { class: 'panel' }, h('h2', null, 'Photo quality'),
    issues.length ? h('ul', { class: 'issues' }, issues.map((i) => h('li', null, i))) : h('p', { class: 'muted' }, 'No quality problems detected.'),
    req.length ? h('div', null, h('h3', null, 'Photos that would resolve an uncertainty'), h('ul', null, req.map((r) => h('li', null, `${r.region} — ${label(r.lighting)} light: ${r.why}`)))) : null);
}

const FIELD_GROUPS = {
  'Card': ['category', 'subject', 'team', 'manufacturer', 'brand', 'product_line', 'set_name', 'subset', 'release_year', 'copyright_year', 'card_number', 'language', 'region', 'edition', 'insert', 'parallel', 'foil_treatment', 'artwork_variation', 'serial_numerator', 'serial_denominator', 'promo_stamp', 'reprint_status', 'error_variation'],
  'Sports details': ['rookie_designation', 'rookie_designation_source', 'prospect_designation', 'first_card_designation', 'licensed_status', 'autograph_presence', 'autograph_type', 'inscription', 'signer_count', 'manufacturer_autograph_statement', 'relic_type', 'relic_count', 'relic_claim_class', 'patch_colors_observed', 'relic_wording'],
  'Pokémon details': ['set_symbol_code', 'rarity', 'first_edition_mark', 'shadowless', 'holo_treatment', 'texture'],
  'Slab': ['is_slabbed', 'grading_company', 'label_text', 'card_grade', 'autograph_grade', 'subgrades', 'qualifiers', 'label_designation', 'cert_number', 'slab_damage'],
  'Other': ['visible_text', 'catalog_ids', 'reference_urls'],
};

function identityPanel(d, cur, id) {
  if (!cur) return h('span');
  const err = errBox();
  const inputs = {};
  const groups = Object.entries(FIELD_GROUPS).map(([g, names]) => {
    const rows = names.map((n) => {
      const f = cur.fields[n] || { value: null, status: 'unknown' };
      const ai = cur.ai_suggestion?.[n];
      const inp = h('input', { id: `fld-${n}`, value: f.value ?? '', 'data-orig': f.value ?? '' });
      inputs[n] = inp;
      return h('div', { class: 'fieldrow' }, h('label', { for: `fld-${n}` }, label(n)), inp,
        h('div', { class: 'meta' }, statusChip(f.status), f.evidence ? ` ${f.evidence}` : '', f.uncertainty ? ` — ${f.uncertainty}` : '', ai && ai.value !== f.value ? ` (AI suggested: ${ai.value ?? 'none'})` : ''));
    });
    const anyVal = names.some((n) => cur.fields[n]?.value);
    return h('details', { open: g === 'Card' || (anyVal && g !== 'Other') }, h('summary', null, g), rows);
  });
  const rg = h('select', { id: 'id-rg' }, [['', 'Unknown'], ['raw', 'Raw'], ['graded', 'Graded']].map(([v, t]) => h('option', { value: v, selected: (d.card.raw_or_graded || '') === v }, t)));
  const submit = (chosenCandidate) => async () => {
    const corrections = Object.entries(inputs).filter(([, i]) => i.value.trim() !== i.dataset.orig).map(([name, i]) => ({ name, value: i.value.trim() || null }));
    const r = await api(`/api/cards/${id}/identity`, { method: 'POST', json: { basedOnVersionId: cur.id, corrections, chosenCandidate, rawOrGraded: rg.value || null } });
    route();
    return r;
  };
  const cands = (cur.candidates || []).map((cand, i) => {
    const b = h('button', { class: 'btn', onclick: () => guarded(b, err, submit(i)) }, 'This one');
    return h('li', null, h('b', null, cand.label), ` — distinguishing attribute: ${cand.distinguishing_attribute} `, b);
  });
  const confirmBtn = h('button', { class: 'btn primary', onclick: () => guarded(confirmBtn, err, submit(null)) }, cur.confirmed ? 'Save correction (refreshes comps)' : 'Confirm identity');
  const needs = d.card.analysis_state === 'needs_identification';
  return h('div', { class: 'panel' },
    h('h2', null, needs ? 'Is this the card?' : 'Card identity'),
    cands.length ? h('div', null, h('p', null, h('b', null, 'More than one version is still possible. Which one is yours?')), h('ul', null, cands)) : null,
    d.extraction?.validation_notes?.length ? h('p', { class: 'small muted' }, d.extraction.validation_notes.join(' ')) : null,
    h('details', { open: needs }, h('summary', null, needs ? 'Review and edit fields' : 'View or correct fields'),
      h('p', { class: 'small muted' }, 'Edit anything that is wrong. Your corrections are stored as owner-reported, alongside the original AI suggestion. A correction always triggers fresh comparable sales; previous reports are kept.'),
      groups, h('label', { for: 'id-rg' }, 'Raw or graded'), rg),
    h('div', { class: 'btns' }, confirmBtn), err);
}

function questionsPanel(d, id) {
  const err = errBox();
  const pending = d.questions.filter((q) => q.answer_status === 'pending');
  const state = {};
  const blocks = pending.map((q) => {
    const name = `q-${q.id}`;
    const free = h('input', { 'aria-label': 'Your answer', placeholder: 'Type an answer (optional)', oninput: () => { state[q.id] = { status: 'answered', answer: free.value }; } });
    const opt = (v, text, status) => h('label', null, h('input', { type: 'radio', name, onchange: () => { state[q.id] = { status, answer: status === 'answered' ? v : null }; free.value = status === 'answered' ? v : ''; } }), text);
    return h('fieldset', { class: 'q' }, h('legend', null, q.text), h('div', { class: 'small muted' }, `Why: affects ${label(q.reason)}`),
      h('div', { class: 'opts' }, (q.options || []).map((o) => opt(o, o, 'answered')), opt('', 'Unknown', 'unknown'), opt('', 'Skip', 'skipped')), free);
  });
  const b = h('button', { class: 'btn primary', onclick: () => guarded(b, err, async () => {
    const answers = pending.map((q) => ({ id: q.id, status: state[q.id]?.status || 'skipped', answer: state[q.id]?.answer ?? null }));
    await api(`/api/cards/${id}/answers`, { method: 'POST', json: { answers } });
    route();
  }) }, 'Submit answers');
  return h('div', { class: 'panel' }, h('h2', null, 'A few questions'), h('p', { class: 'small muted' }, 'Answers are recorded as owner-reported information. "Unknown" is always fine.'), blocks, h('div', { class: 'btns' }, b), err);
}

function conditionPanel(d, imgs) {
  const obs = d.observations;
  const x = d.extraction.output;
  const overlay = (side) => {
    const im = imgs[side];
    if (!im?.copy) return null;
    const boxes = obs.filter((o) => o.image === side && o.status === 'visible' && (o.user_bbox || (o.bbox && o.bbox_reliable))).map((o) => {
      const b = o.user_bbox || o.bbox;
      return h('div', { class: `box ${o.user_bbox ? 'user' : ''}`, style: { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` } }, h('span', null, label(o.aspect)));
    });
    return h('div', { class: 'photo' }, h('img', { src: `/api/assets/${im.copy.id}`, alt: `${side} with marked observations` }), boxes);
  };
  const rows = obs.map((o) => h('tr', null, h('td', null, o.image), h('td', null, label(o.aspect)), h('td', null, h('span', { class: `chip ${o.status === 'visible' ? 'warn' : ''}` }, label(o.status))), h('td', null, o.severity || ''), h('td', null, o.attributed_to !== 'card' ? `${o.attributed_to} (not the card)` : 'card'), h('td', null, o.explanation)));
  const crops = imgs.crops.map((c) => h('figure', null, h('img', { src: `/api/assets/${c.id}`, alt: c.label }), h('figcaption', null, label(c.label))));
  const ce = x.centering;
  return h('div', { class: 'panel' },
    h('h2', null, 'Condition observations'),
    h('p', { class: 'small muted' }, 'Photo-based observations only — not a professional grade or authentication. "Not observed" means not seen in these photos, not that the card is free of it.'),
    h('div', { class: 'photos' }, overlay('front'), overlay('back')),
    h('p', null, h('b', null, 'Photo-based condition band: '), label(x.condition_band), h('span', { class: 'muted small' }, ` — ${x.condition_band_rationale}`)),
    h('p', { class: 'small' }, h('b', null, 'Centering: '), ce.measurable ? `approx. front ${ce.front_left_right ?? '?'} L/R, ${ce.front_top_bottom ?? '?'} T/B; back ${ce.back_left_right ?? '?'} L/R, ${ce.back_top_bottom ?? '?'} T/B. ${ce.method_note}` : `not reliably measurable — ${ce.method_note}`),
    h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Side', 'Aspect', 'Status', 'Severity', 'Attributed to', 'Note'].map((t) => h('th', null, t)))), h('tbody', null, rows))),
    crops.length ? h('div', null, h('h3', null, 'Evidence crops'), h('div', { class: 'crops' }, crops)) : null,
    x.authenticity_notes?.length ? h('div', null, h('h3', null, 'Authenticity notes'), h('ul', null, x.authenticity_notes.map((n) => h('li', null, `${label(n.topic)}: ${n.note}${n.material ? ' (material)' : ''}`)))) : null);
}

function notesPanel(d, id) {
  const err = errBox();
  const notes = h('textarea', { id: 'owner-notes' }); notes.value = d.card.owner_notes || '';
  const saveNotes = h('button', { class: 'btn', onclick: () => guarded(saveNotes, err, async () => { await api(`/api/cards/${id}`, { method: 'PATCH', json: { ownerNotes: notes.value } }); saveNotes.textContent = 'Saved'; }) }, 'Save notes');
  const kind = h('select', { id: 'prov-kind' }, ['acquisition', 'signing', 'receipt', 'certificate', 'previous_listing', 'other'].map((k) => h('option', { value: k }, label(k))));
  const stmt = h('textarea', { id: 'prov-stmt', placeholder: 'e.g. Pulled from a sealed hobby box in 2021; signed in person at a 2019 show.' });
  let docFile = null;
  const addProv = h('button', { class: 'btn', onclick: () => guarded(addProv, err, async () => {
    const docIds = [];
    if (docFile) docIds.push((await upload(id, 'document', docFile, `${kind.value} document`)).id);
    await api(`/api/cards/${id}/provenance`, { method: 'POST', json: { kind: kind.value, statement: stmt.value, documentAssetIds: docIds } });
    route();
  }) }, 'Add provenance');
  const docInput = h('input', { type: 'file', id: 'prov-doc', accept: 'application/pdf,image/*', onchange: () => { docFile = docInput.files?.[0] || null; } });
  return h('div', { class: 'panel' },
    h('h2', null, 'Additional information & provenance'),
    h('label', { for: 'owner-notes' }, 'Additional information'), notes, h('div', { class: 'btns' }, saveNotes),
    d.provenance.length ? h('ul', null, d.provenance.map((p) => h('li', null, statusChip(p.verification_status), ` ${label(p.kind)}: ${p.statement}`))) : null,
    h('details', null, h('summary', null, 'Add provenance, receipt or certificate'),
      h('label', { for: 'prov-kind' }, 'Type'), kind, h('label', { for: 'prov-stmt' }, 'Statement'), stmt,
      h('label', { for: 'prov-doc' }, 'Document (optional, PDF or image — kept private, never sent to pricing sources)'), docInput,
      h('p', { class: 'small muted' }, 'Owner claims stay labeled owner-reported unless independently supported. Purchase price is optional and never used in the estimate.'),
      h('div', { class: 'btns' }, addProv)), err);
}

function runsPanel(d, id) {
  return h('div', { class: 'panel' }, h('h2', null, 'Report history'),
    h('ul', null, d.runs.map((r) => h('li', null, h('a', { href: `#/card/${id}/report/${r.id}` }, `Revision ${r.report_revision}`), ` — ${new Date(r.created_at).toLocaleString()} — ${label(r.headline?.kind)} — evidence ${r.strength}`))),
    (() => { const err = errBox(); const b = h('button', { class: 'btn', onclick: () => guarded(b, err, async () => { await api(`/api/cards/${id}/revalue`, { method: 'POST' }); route(); }) }, 'Revalue now (keeps old reports)'); return h('div', null, b, err); })());
}

function ownerCompPanel(d, id) {
  const err = errBox();
  const f = (idn, lbl, attrs = {}) => { const i = h('input', { id: idn, ...attrs }); return [h('label', { for: idn }, lbl), i]; };
  const [lu, url] = f('oc-url', 'Link to the original sold listing', { type: 'url', placeholder: 'https://' });
  const [lm, mkt] = f('oc-mkt', 'Marketplace / auction house');
  const [ld, date] = f('oc-date', 'Sale date', { type: 'date' });
  const [lt, title] = f('oc-title', 'Listing title');
  const [la, amt] = f('oc-amt', 'Amount', { type: 'number', step: '0.01', min: '0' });
  const [lc, cur] = f('oc-cur', 'Currency', { value: d.card.currency, maxlength: 3 });
  const basis = h('select', { id: 'oc-basis' }, [['item_price', 'Item price (no buyer premium, excl. shipping)'], ['hammer_plus_premium', 'Auction price incl. buyer premium'], ['hammer', 'Hammer only (premium not included)'], ['total_including_shipping', 'Total incl. shipping/tax'], ['unknown', 'Not sure']].map(([v, t]) => h('option', { value: v }, t)));
  const format = h('select', { id: 'oc-fmt' }, [['fixed_price', 'Fixed price'], ['marketplace_auction', 'Marketplace auction'], ['best_offer', 'Accepted offer (amount known)'], ['auction', 'Auction house'], ['private', 'Private sale'], ['unknown', 'Unknown']].map(([v, t]) => h('option', { value: v }, t)));
  const gstate = h('select', { id: 'oc-gs' }, [['raw', 'Raw'], ['graded', 'Graded']].map(([v, t]) => h('option', { value: v }, t)));
  const grader = h('select', { id: 'oc-grader' }, [['', '—'], ['PSA', 'PSA'], ['BGS', 'BGS'], ['SGC', 'SGC'], ['CGC', 'CGC'], ['other', 'Other']].map(([v, t]) => h('option', { value: v }, t)));
  const [lg, cg] = f('oc-cg', 'Card grade');
  const same = h('input', { type: 'checkbox', id: 'oc-same' });
  const b = h('button', { class: 'btn', onclick: () => guarded(b, err, async () => {
    await api(`/api/cards/${id}/comps`, { method: 'POST', json: {
      url: url.value, marketplace: mkt.value, saleDate: date.value, title: title.value, amount: Number(amt.value), currency: cur.value.toUpperCase(),
      priceBasis: basis.value, saleFormat: format.value, sameCardConfirmed: same.checked,
      grade: { state: gstate.value, grader: gstate.value === 'graded' ? grader.value || null : null, cardGrade: gstate.value === 'graded' ? cg.value || null : null, autographGrade: null, qualifiers: [] },
    } });
    b.textContent = 'Added — revalue to include';
  }) }, 'Add sold record');
  return h('div', { class: 'panel' }, h('details', null, h('summary', null, 'Add a sold record you found'),
    h('p', { class: 'small muted' }, 'Only completed sales that actually sold. Records you add are labeled owner-supplied and are not treated as independently verified.'),
    h('div', { class: 'grid2' }, h('div', null, lu, url), h('div', null, lm, mkt), h('div', null, ld, date), h('div', null, lt, title), h('div', null, la, amt), h('div', null, lc, cur),
      h('div', null, h('label', { for: 'oc-basis' }, 'What the amount includes'), basis), h('div', null, h('label', { for: 'oc-fmt' }, 'Sale format'), format),
      h('div', null, h('label', { for: 'oc-gs' }, 'Raw or graded'), gstate), h('div', null, h('label', { for: 'oc-grader' }, 'Grader'), grader), h('div', null, lg, cg)),
    h('label', null, same, ' I checked this is exactly the same card (set, number, parallel, language, edition)'),
    h('div', { class: 'btns' }, b), err));
}

function dangerPanel(id) {
  const err = errBox();
  const b = h('button', { class: 'btn danger', onclick: () => guarded(b, err, async () => {
    if (!confirm('Delete this card, its photos, documents and reports permanently?')) return;
    await api(`/api/cards/${id}`, { method: 'DELETE' });
    location.hash = '#/';
  }) }, 'Delete card and images');
  return h('div', { class: 'panel' }, h('details', null, h('summary', null, 'Delete'), h('p', { class: 'small muted' }, 'Deletes the card, original and derived images, documents, evidence and reports held by this app.'), b, err));
}

// ---------------------------------------------------------------- report (Screens D/E)
async function viewReport(cardId, runId) {
  const [rep, d] = await Promise.all([api(`/api/cards/${cardId}/reports/${runId}`), api(`/api/cards/${cardId}`)]);
  render(h('p', null, h('a', { href: `#/card/${cardId}` }, '← Back to card')), reportView(rep, cardId, d));
}

function reportView(rep, cardId, d) {
  const r = rep.result;
  const hd = r.headline;
  const cur = r.currency;
  const superseded = rep.run.revision !== rep.run.latestRevision;
  const kindText = { estimate: 'Estimated value', tentative: 'Tentative value', limited: 'Limited evidence', insufficient: 'Insufficient evidence', broad_indication_only: 'Broad raw-card indication only', suppressed: 'No value shown', conditional: 'Conditional value' }[hd.kind];
  let big = '';
  if (hd.display.central != null) big = fmt(hd.display.central, cur);
  else if (hd.display.low != null) big = hd.display.low === hd.display.high ? fmt(hd.display.low, cur) : `${fmt(hd.display.low, cur)} – ${fmt(hd.display.high, cur)}`;
  const st = (t, v, chip) => h('div', { class: 'status' }, h('b', null, t), chip ? statusChip(chip) : null, ' ', v);
  const showExcluded = h('input', { type: 'checkbox', id: 'show-ex' });
  const tbody = h('tbody');
  const fillComps = () => {
    const rows = rep.comps.filter((c) => showExcluded.checked || c.pool).sort((a, b) => (a.pool ? 0 : 1) - (b.pool ? 0 : 1) || String(b.saleDate).localeCompare(String(a.saleDate)));
    tbody.replaceChildren(...rows.map((c) => compRow(c, cur, cardId)));
    if (!rows.length) tbody.append(h('tr', null, h('td', { colspan: 7 }, 'No records.')));
  };
  showExcluded.addEventListener('change', fillComps);
  fillComps();
  const certText = rep.certificate ? `${rep.certificate.grader} #${rep.certificate.certNumber} via ${rep.certificate.provider}${rep.certificate.mismatches?.length ? ` — mismatch: ${rep.certificate.mismatches.map((m) => `${m.field} (label ${m.label} vs record ${m.record})`).join('; ')}` : ''}. ${rep.certificate.note}` : r.subjectGrade === 'raw' ? 'Not applicable (raw card)' : 'Not checked';
  return h('div', null,
    r.containsFixtureData ? h('div', { class: 'banner', role: 'alert' }, 'FIXTURE DATA — synthetic test records. This is not a market valuation.') : null,
    superseded ? h('p', { class: 'err' }, `This is revision ${rep.run.revision}; a newer report (revision ${rep.run.latestRevision}) exists.`) : null,
    h('div', { class: 'panel' },
      h('div', { class: 'muted small' }, rep.identity?.label),
      h('h2', null, kindText),
      big ? h('div', { class: 'value' }, big) : null,
      hd.display.central != null && hd.display.low != null ? h('div', null, `${hd.kind === 'estimate' ? 'Recent comparable-sales band' : 'Observed range'}: ${fmt(hd.display.low, cur)} – ${fmt(hd.display.high, cur)}`) : null,
      h('p', null, hd.statement),
      h('p', { class: 'small muted' }, `${new Date(rep.audit.valuationTimestamp).toLocaleString()} · ${cur} · ${r.priceBasis} · ${r.subjectGrade} · ${r.precise.eventCount} direct comp(s), effective sample ${r.precise.effectiveSampleSize.toFixed(1)} · window ${r.window.selectedDays} days`),
      r.broad.eventCount && hd.kind !== 'broad_indication_only' ? h('p', { class: 'small' }, `Broader raw-card indication (not condition-matched): ${r.broad.eventCount} sale(s), ${fmt(r.broad.band?.lowMinor ?? r.broad.unweightedMedianMinor, cur)} – ${fmt(r.broad.band?.highMinor ?? r.broad.unweightedMedianMinor, cur)}`) : null,
      h('div', { class: 'btns' }, h('a', { class: 'btn', href: `/api/cards/${cardId}/reports/${rep.run.id}/print`, target: '_blank', rel: 'noopener' }, 'Printable report'))),
    h('div', { class: 'panel' }, h('h2', null, 'Status'), h('div', { class: 'statuses' },
      st('Card identity', r.confidence.identity),
      st('Visible condition', r.confidence.conditionVisibility),
      st('Autograph', rep.autographStatus),
      st('Relic claim', rep.relicStatus),
      st('Slab record', certText, rep.certificate?.status || null),
      st('Market evidence', `${r.precise.independentEventCount} independent event(s)`, r.strength === 'strong' ? 'observed' : r.strength))),
    r.flags.length ? h('div', { class: 'panel' }, h('h2', null, 'Things to know'), h('ul', null, r.flags.map((f) => h('li', null, f)))) : null,
    h('div', { class: 'panel' }, h('h2', null, 'Explanation'), h('p', null, rep.explanation?.summary), h('ul', null, (rep.explanation?.points || []).map((p) => h('li', null, p.text, p.evidence_ids.length ? h('span', { class: 'small muted' }, ` [${p.evidence_ids.slice(0, 6).join(', ')}${p.evidence_ids.length > 6 ? '…' : ''}]`) : null))),
      h('p', null, h('b', null, 'Next best action: '), rep.nextBestAction),
      rep.explanationMeta?.source !== 'model' ? h('p', { class: 'small muted' }, `Explanation generated by the application (${rep.explanationMeta?.reason || 'no model explanation'}).`) : null),
    r.scenarioGroups.length ? h('div', { class: 'panel' }, h('h2', null, 'Other grades / conditions (scenario evidence, not your card\'s value)'),
      h('ul', null, r.scenarioGroups.map((g) => h('li', null, `${g.label}: ${g.count} sale(s), ${fmt(g.lowMinor, cur)} – ${fmt(g.highMinor, cur)}${g.medianMinor != null ? `, median ${fmt(g.medianMinor, cur)}` : ''}`))),
      h('p', { class: 'small muted' }, 'Hypothetical: there is no promise a card would receive any grade.')) : null,
    r.guideBenchmarks.length ? h('div', { class: 'panel' }, h('h2', null, 'Price-guide benchmarks (aggregates, not sales)'), h('ul', null, r.guideBenchmarks.map((g) => h('li', null, `${g.provider}: ${fmt(g.valueMinor, g.currency)} as of ${g.asOf} — ${g.note}`)))) : null,
    h('div', { class: 'panel' }, h('h2', null, 'Comparable sales'),
      h('label', null, showExcluded, ' Show excluded, scenario and context records'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'stack' }, h('thead', null, h('tr', null, ['Date', 'Sale', 'Grade', 'Price', 'Normalized', 'Decision', ''].map((t) => h('th', null, t)))), tbody))),
    h('div', { class: 'panel' }, h('h2', null, 'Sources searched'), h('div', { class: 'tablewrap' }, h('table', null, h('tbody', null, rep.sources.map((s) => h('tr', null, h('td', null, s.name), h('td', null, s.searched ? h('span', { class: 'chip ok' }, 'searched') : h('span', { class: 'chip' }, label(s.status))), h('td', { class: 'small' }, s.searched ? `${s.count} record(s)${s.windowDays ? `, last ${s.windowDays} days` : ''}${s.truncated ? ', TRUNCATED' : ''}, ${new Date(s.retrievedAt).toLocaleString()}` : s.failure || s.reason)))))),
      h('p', { class: 'small muted' }, 'Only connected, permitted sources are searched. Complete market coverage cannot be guaranteed.')),
    h('details', { class: 'panel' }, h('summary', null, 'Audit details'), h('ul', { class: 'small' },
      h('li', null, `Identification model: ${rep.audit.extractionModel} (reasoning effort ${rep.audit.reasoningEffort})`),
      h('li', null, `Prompt ${rep.audit.promptVersion}; schema ${rep.audit.schemaVersion}`),
      h('li', null, `Calculation ${rep.audit.calcVersion}; report revision ${rep.audit.reportRevision}; identity version ${rep.audit.identityVersion}`),
      h('li', null, `Explanation: ${rep.explanationMeta?.source}${rep.explanationMeta?.modelId ? ` (${rep.explanationMeta.modelId})` : ''}`))),
    h('p', { class: 'small muted' }, rep.notice));
}

function compRow(c, cur, cardId) {
  const err = h('span', { class: 'err small' });
  const flag = h('button', { class: 'btn small', onclick: () => guarded(flag, err, async () => {
    const reason = prompt('What is wrong with this record? (logged; it will be excluded from the next revaluation)');
    if (!reason) return;
    await api(`/api/cards/${cardId}/comps/${c.evidenceId}/flag`, { method: 'POST', json: { action: c.pool ? 'exclude_next_run' : 'report_mistake', reason } });
    flag.textContent = 'Flagged';
  }) }, 'Flag');
  const decision = c.pool ? `Included (${c.pool === 'broad' ? 'broad indication' : 'direct'}), weight ${c.weight.toFixed(2)}` : c.exclusionText.length ? c.exclusionText.join(' ') : c.tier === 'B' ? 'Scenario evidence (different grade/condition)' : c.tier === 'C' ? 'Context only (related card)' : 'Not used';
  return h('tr', { class: c.pool ? '' : 'excluded' },
    h('td', { 'data-label': 'Date' }, c.saleDate, h('div', { class: 'small muted' }, c.evidenceId)),
    h('td', { 'data-label': 'Sale' }, c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, c.title) : c.title, h('div', { class: 'small muted' }, `${c.provider} / ${c.originMarketplace} · ${label(c.saleFormat)}`), c.isFixture ? h('span', { class: 'chip bad' }, 'FIXTURE') : null, c.acquisitionMethod === 'owner_supplied' ? h('span', { class: 'chip warn' }, 'owner-supplied') : null),
    h('td', { 'data-label': 'Grade' }, c.gradeLabel),
    h('td', { 'data-label': 'Price' }, c.reportedAmountMinor == null ? '—' : `${c.originalCurrency} ${(c.reportedAmountMinor / 100).toFixed(2)}`, h('div', { class: 'small muted' }, label(c.priceBasis))),
    h('td', { 'data-label': 'Normalized' }, fmt(c.normalizedMinor, cur), c.fx ? h('div', { class: 'small muted' }, `FX ${c.fx.rate} (${c.fx.rateDate})`) : null),
    h('td', { class: 'small', 'data-label': 'Decision' }, decision, c.notes.length ? h('div', { class: 'muted' }, c.notes.join(' ')) : null, c.flags.length ? h('div', { class: 'muted' }, c.flags.join(' ')) : null, c.userFlags?.length ? h('div', null, `You flagged: ${c.userFlags.map((f) => f.reason).join('; ')}`) : null),
    h('td', null, flag, err));
}

// ---------------------------------------------------------------- connectors
async function viewConnectors() {
  const c = await api('/api/connectors');
  const err = errBox();
  const out = h('p', { class: 'small' });
  const test = h('button', { class: 'btn', onclick: () => guarded(test, err, async () => { const r = await api('/api/system/model-check', { method: 'POST' }); out.textContent = `${r.ok ? 'OK' : 'Unavailable'}: ${r.detail}`; }) }, 'Test model access');
  render(
    h('h1', null, 'Sources & connectors'),
    h('div', { class: 'panel' }, h('h2', null, 'Identification model'), h('p', null, `${c.model.id} · reasoning effort ${c.model.reasoningEffort} · ${c.model.configured ? 'API key configured' : 'API key NOT configured'}`), test, out, err, h('p', { class: 'small muted' }, `FX: ${c.fx}`)),
    h('div', { class: 'panel' }, h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Source', 'Status', 'Data type', 'Access finding', 'Rights'].map((t) => h('th', null, t)))),
      h('tbody', null, c.providers.map((p) => h('tr', null,
        h('td', null, h('b', null, p.name), h('div', { class: 'small muted' }, p.categories.join(', '))),
        h('td', null, h('span', { class: `chip ${p.status === 'connected' ? 'ok' : p.status === 'unsupported' ? 'bad' : 'warn'}` }, label(p.status)), h('div', { class: 'small muted' }, p.statusDetail)),
        h('td', { class: 'small' }, `${label(p.contentType)}; ${p.purposes.map(label).join(', ')}`),
        h('td', { class: 'small' }, p.accessFinding, p.sourceRefs.map((u) => h('div', null, h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u)))),
        h('td', { class: 'small' }, `${p.rights.allowedUses} Display: ${p.rights.displayAllowed ? 'yes' : 'no'}. Export: ${p.rights.exportAllowed ? 'yes' : 'no'}. Retention: ${p.rights.retentionDays ?? 'unknown'}.`))))))));
}

route();
