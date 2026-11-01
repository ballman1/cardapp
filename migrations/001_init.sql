-- Trading card identification & valuation — initial schema (spec §11)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE card_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
  title text,
  owner_notes text NOT NULL DEFAULT '',
  category_hint text,                        -- null = automatic detection
  raw_or_graded text,                        -- 'raw' | 'graded' | null (unknown)
  ownership_status text,
  currency char(3) NOT NULL DEFAULT 'USD',
  market_region text NOT NULL DEFAULT 'US',
  valuation_purpose text NOT NULL DEFAULT 'ordinary_resale',
  purchase_price_minor bigint,               -- optional; never used by the valuation engine
  purchase_currency char(3),
  analysis_state text NOT NULL DEFAULT 'needs_photos',
  current_identity_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON card_instances (user_id, created_at DESC);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  kind text NOT NULL,                        -- front|back|detail|document|crop|analysis_copy
  parent_asset_id uuid REFERENCES assets(id) ON DELETE CASCADE,
  label text,                                -- region label for crops / caption for details
  storage_key text NOT NULL,
  mime text NOT NULL,
  bytes integer NOT NULL,
  sha256 text NOT NULL,
  width integer,
  height integer,
  quality jsonb,
  bbox jsonb,
  superseded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON assets (card_id, kind);

CREATE TABLE extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  job_id uuid,
  model_id text NOT NULL,
  reasoning_effort text,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  input_asset_ids jsonb NOT NULL,
  output jsonb NOT NULL,
  validation_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  version integer NOT NULL,
  source text NOT NULL,                      -- model | user_correction | user_confirmation | catalog
  based_on_version_id uuid REFERENCES identity_versions(id),
  extraction_id uuid REFERENCES extractions(id),
  fields jsonb NOT NULL,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_suggestion jsonb,                       -- preserved model suggestion, never overwritten
  correction_diff jsonb,
  confirmed boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, version)
);

ALTER TABLE card_instances
  ADD CONSTRAINT card_current_identity_fk FOREIGN KEY (current_identity_version_id) REFERENCES identity_versions(id) ON DELETE SET NULL;

CREATE TABLE observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  extraction_id uuid REFERENCES extractions(id) ON DELETE CASCADE,
  aspect text NOT NULL,
  image text NOT NULL,                       -- front|back
  status text NOT NULL,                      -- visible|not_observed|not_assessable
  severity text,
  bbox jsonb,
  bbox_reliable boolean NOT NULL DEFAULT false,
  user_bbox jsonb,
  explanation text NOT NULL,
  attributed_to text NOT NULL DEFAULT 'card', -- card|slab|sleeve|unknown
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  round integer NOT NULL,
  code text NOT NULL,
  field text,
  text text NOT NULL,
  reason text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer text,
  answer_status text NOT NULL DEFAULT 'pending', -- pending|answered|unknown|skipped
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provenance_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,                        -- acquisition|signing|receipt|certificate|previous_listing|other
  statement text NOT NULL,
  document_asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  verification_status text NOT NULL DEFAULT 'owner_reported',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE certificate_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  identity_version_id uuid REFERENCES identity_versions(id) ON DELETE CASCADE,
  grader text NOT NULL,
  cert_number text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL,
  returned jsonb,
  mismatches jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_configs (
  provider_id text PRIMARY KEY,
  status text NOT NULL,
  last_health_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retrievals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  identity_version_id uuid NOT NULL REFERENCES identity_versions(id) ON DELETE CASCADE,
  job_id uuid,
  sources jsonb NOT NULL,                    -- per-provider: searched, window, retrieved_at, count, truncated, failure
  guide_benchmarks jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  retrieval_id uuid REFERENCES retrievals(id) ON DELETE CASCADE,
  provider text NOT NULL,
  origin_marketplace text NOT NULL,
  source_record_id text,
  canonical_url text,
  acquisition_method text NOT NULL,
  is_fixture boolean NOT NULL,
  retrieved_at timestamptz NOT NULL,
  record jsonb NOT NULL,                     -- full ingestion contract (§7)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sales_records (card_id);

CREATE TABLE valuation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_version_id uuid NOT NULL REFERENCES identity_versions(id) ON DELETE CASCADE,
  retrieval_id uuid REFERENCES retrievals(id) ON DELETE CASCADE,
  report_revision integer NOT NULL,
  calc_version text NOT NULL,
  settings jsonb NOT NULL,
  inputs jsonb NOT NULL,                     -- frozen subject, gates, evidence ids, excluded ids
  result jsonb NOT NULL,
  explanation jsonb,
  explanation_meta jsonb,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, report_revision)
);

CREATE TABLE duplicate_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  valuation_run_id uuid NOT NULL REFERENCES valuation_runs(id) ON DELETE CASCADE,
  primary_evidence_id text NOT NULL,
  member_evidence_ids jsonb NOT NULL,
  reasons jsonb NOT NULL
);

CREATE TABLE comp_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evidence_id text NOT NULL,
  action text NOT NULL,                      -- exclude_next_run | report_mistake
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES card_instances(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,                        -- extract | value
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued',      -- queued|running|done|failed
  stage text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 4,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  last_error_code text,
  last_error text,
  costs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON analysis_jobs (state, run_after);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  card_id uuid REFERENCES card_instances(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events (card_id, created_at);

