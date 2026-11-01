# Card Evidence: trading card identification & valuation (MVP)

A mobile-friendly web app that takes front and back photos of a baseball, football, basketball, hockey or Pokémon card, then:

1. identifies the exact card,
2. records what is visible about its condition,
3. collects the owner's notes and provenance,
4. retrieves comparable sales from **permitted** sources,
5. produces a reproducible market estimate along with the evidence behind it.

This repository implements the Phase 1 (MVP) scope of the *Trading Card Identification & Valuation App* specification (Nov 1, 2026).

> **Status: identification and valuation machinery only. No live market data is connected.**
> None of the commercial sales sources in the spec (eBay Marketplace Insights, 130point, Heritage, Goldin, Fanatics Collect, Card Ladder, …) is enabled, because no permitted access route exists yet (see [Sources](#data-sources-what-is-actually-connected)). Until a licensed transaction feed is connected, the app can identify cards and value them only from owner-supplied sold records. It must not be described as performing an automatic market appraisal.

## Quick start

Requirements: Node 22+, PostgreSQL 14+.

```bash
npm install
```

```bash
cp .env.example .env   # then set OPENAI_API_KEY, DATABASE_URL, SESSION_SECRET
```

```bash
createdb cardvalue && npm run migrate
```

```bash
npm run dev   # http://localhost:3000 (the job worker runs in-process outside production)
```

The server loads environment variables from the process. With `.env`, use `node --env-file=.env` or your process manager. In production, run the worker separately: set `WORKER_IN_PROCESS=false` and run `npm run worker`.

On startup the server runs a **model capability test** with the deployed key and logs `OK` or `UNAVAILABLE`. You can also run it from **Sources → Test model access**. If the configured model is not accessible, identification jobs fail with `model_access`. The app never silently switches to a different model.

For a local demo without real sales data, set `ALLOW_FIXTURES=true`. This enables a synthetic sales generator. Every fixture record and report carries a red **FIXTURE** banner, fixture data can never reach "strong" evidence, and the setting is ignored when `NODE_ENV=production`.

### Tests

```bash
npm test   # unit tests; DB integration tests are skipped without a database
```

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/cardvalue_test npm test   # everything
```

```bash
npm run typecheck
```

⚠️ The integration suite **drops and recreates the `public` schema** of `TEST_DATABASE_URL`. Point it at a throwaway database.

## How it works

```
photos ─► image checks ─► model extraction ─► owner confirms/corrects identity ─► targeted questions
        (blur, glare,      (strict schema,      (new identity version; AI          (≤4, Unknown/Skip;
         resolution,        crops, condition     suggestion preserved)              answers = owner_reported)
         EXIF stripped)     observations)
                                                   ─► cert check ─► retrieval ─► deterministic valuation ─► validated explanation
                                                      (PSA if      (connected     (src/valuation, pure,      (model may not add numbers
                                                       configured)  sources only)   versioned settings)        or unknown evidence IDs)
```

Each stage is persisted (`extractions`, `identity_versions`, `certificate_checks`, `retrievals`, `valuation_runs`). A retry resumes from the failed stage. Jobs are deduplicated by idempotency key and retried with bounded exponential backoff.

| Path | What it does |
|---|---|
| `src/valuation/` | Match tiers A/B/C, hard exclusions, cross-source dedupe, price-basis/FX normalization, weighted median and percentiles, n_eff, outlier/volatility flags, evidence-strength gates (§8). Pure and deterministic. |
| `src/ai/` | OpenAI Responses API client, versioned prompts (§14), strict JSON schemas, and explanation guardrails. |
| `src/domain/identity.ts` | Provenance-tagged fields, owner corrections, identity and authenticity gates. |
| `src/providers/` | Adapter contracts, the provider catalog with spec access findings, PSA cert lookup, FX, fixtures. |
| `src/jobs/` | Postgres job queue, pipeline stages, worker. |
| `src/routes/` | REST API, report assembly, printable report, CSV export. |
| `public/` | No-build single-page client. Built with DOM APIs (no `innerHTML` with data) under a strict CSP. |
| `migrations/` | SQL schema (§11 entities). |

### Valuation policy (calc version `valuation-2026.11.01-a`)

These settings are design judgments to be backtested before production. Each valuation run stores its full settings.

- **Search window:** 90 days, expanded to 180, 365, then 730 while fewer than 8 direct events are found. Each expansion is recorded.
- **Weights:** `w = 2^(−age/180) × condition (1.0 | 0.7) × record quality (1.0 | 0.8)`.
- **Central value:** the weighted median, defined as the smallest value whose cumulative weight reaches half the total. The unweighted median and counts are reported alongside it.
- **Results by number of direct sales:**

  | Direct sales | What is shown |
  |---|---|
  | 8 or more independent | Weighted 20th–80th percentile *recent comparable-sales band* |
  | 3–7 | Observed low/high and a tentative median |
  | 1–2 | The records only, with no estimate |
  | 0 | "Insufficient direct sales evidence." |

- **"Strong" evidence** requires all of the following:
  - at least 8 independent events and an effective sample size of at least 5;
  - resolved identity and adequate condition evidence;
  - no outlier, volatility or relist flag;
  - no owner-supplied or fixture data in the pool.
- **Outliers:** flagged when the robust log-z exceeds 3.5. They are retained, and their effect is disclosed.
- **Raw cards:** if condition can't be assessed from photos, the result is a separately labeled *broader raw-card indication*.
- **Unresolved identity or authenticity:** an unresolved identity, a slab-record mismatch, or an autograph whose authenticity is unknown suppresses the unconditional headline.

## Data sources: what is actually connected

| Source | Status in this build | Why |
|---|---|---|
| Owner-supplied sold records | **connected** | Entered by the owner with a link to the sale. Labeled *owner-supplied, not independently verified*. Caps evidence strength at moderate. |
| PSA certificate lookup | connected **only if `PSA_API_TOKEN` is set** | Authenticated PSA Public API. Confirm the endpoint path against current PSA docs in Phase 0 (`PSA_API_BASE_URL` is configurable). A match does not authenticate the physical slab. |
| FX (ECB via Frankfurter) | optional, `FX_PROVIDER=frankfurter` | Historical sale-date rates. The rate, source and date are kept. With `none`, foreign-currency sales appear in a separate group. |
| eBay Marketplace Insights | awaiting access | Restricted; not open to new users. |
| 130point | unsupported | Terms prohibit automated and commercial use without written permission. |
| SportsCardsPro, PriceCharting | not configured | Current-value guides only, not transactions. They could provide separately labeled guide benchmarks once licensed. |
| TCGplayer | awaiting access | New API access is not being granted. |
| Heritage, Fanatics Collect, Goldin, REA, Card Ladder, Market Movers | not configured | Agreements required; rights not verified. |

**Launch dependency (spec §6):** at least one permitted, transaction-level sales feed for sports and Pokémon. To add one:

1. Implement `Provider.searchSales` in `src/providers/`, returning `SaleRecordInput` records (§7 contract).
2. Fill in its `rights`.
3. Register it in `createRegistry`.

The Sources page and every report list exactly which sources were searched, their windows, retrieval times, truncation and failures.

## Credentials still required

- `OPENAI_API_KEY` with access to the configured model (`OPENAI_MODEL`, default `gpt-6.1-sol` per the spec; not verified from this environment).
- `PSA_API_TOKEN`, optional.
- A licensed sales-data agreement, as described above.

## Security & privacy

- **Accounts:** email and password, scrypt-hashed. Sessions are HTTP-only SameSite=Strict cookies, and state-changing requests require a CSRF header.
- **Access control:** every card, file, job, report and export query is scoped to its owner. Other users get a 404.
- **Uploads:** checked by magic bytes, size and decoded pixel count. Originals are immutable. Analysis copies have all metadata, including GPS, stripped. Files live in private storage behind authenticated routes, and provenance documents are never sent to pricing providers.
- **Untrusted content:** model outputs are schema-validated, and the model cannot assign `catalog_matched`, `owner_reported` or `provider_verified` statuses. Owner text and listing titles are delimited as untrusted data, and the valuation engine ignores free text entirely.
- **Deletion:** deleting a card removes its rows (cascade) and stored files.
- **Exports:** CSV cells are guarded against formula injection. Evidence URLs are exported only from providers whose rights allow it.

## Not yet implemented

- **Catalog matching against a licensed catalog:** no catalog provider is connected, so identities remain model-observed or owner-reported.
- **Guide benchmarks:** the code path exists, but no licensed guide is connected.
- **Multi-card selection:** multi-card photos are detected and the owner is asked for single-card photos; there is no in-photo selector.
- **Location correction:** users can correct observation locations through the API (`POST /api/cards/:id/observations/:obsId`), but there is no drag UI yet.
- **Storage:** an S3/GCS object store adapter (local filesystem only today) and document virus scanning.
- **Phase 2 items:** grading economics, price tracking, bulk capture and human-review queues.
- **Evaluation:** a labeled evaluation set and valuation backtests. Confidence labels are qualitative until calibrated, and **no accuracy claim is made**.
