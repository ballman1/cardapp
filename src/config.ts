/** Application configuration from environment variables. No secrets are ever sent to the client. */
import path from 'node:path';

const bool = (v: string | undefined, d = false) => (v == null ? d : /^(1|true|yes)$/i.test(v));
const num = (v: string | undefined, d: number) => (v == null || v === '' ? d : Number(v));

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  storageDir: string;
  sessionSecret: string;
  openai: {
    apiKey: string | null;
    model: string;
    reasoningEffort: string;
    maxOutputTokens: number;
    timeoutMs: number;
    /** Optional USD prices per million tokens for cost tracking. Unset → cost reported as unknown. */
    priceInputPerMTok: number | null;
    priceOutputPerMTok: number | null;
  };
  allowFixtures: boolean;
  workerInProcess: boolean;
  maxUploadBytes: number;
  maxImagePixels: number;
  psa: { apiToken: string | null; baseUrl: string };
  fx: { provider: 'frankfurter' | 'none'; baseUrl: string };
}

export function loadConfig(env = process.env): Config {
  const mode = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as Config['env'];
  const allowFixtures = bool(env.ALLOW_FIXTURES) && mode !== 'production';
  if (bool(env.ALLOW_FIXTURES) && mode === 'production') {
    // Production must never silently substitute fixture sales.
    console.error('[config] ALLOW_FIXTURES ignored in production.');
  }
  const sessionSecret = env.SESSION_SECRET ?? (mode === 'production' ? '' : 'dev-only-insecure-secret');
  if (mode === 'production' && sessionSecret.length < 32) throw new Error('SESSION_SECRET (>=32 chars) is required in production');
  return {
    env: mode,
    port: num(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL ?? 'postgres://cardvalue:cardvalue@localhost:5432/cardvalue',
    storageDir: path.resolve(env.STORAGE_DIR ?? './data/storage'),
    sessionSecret,
    openai: {
      apiKey: env.OPENAI_API_KEY || null,
      model: env.OPENAI_MODEL ?? 'gpt-6.1-sol',
      reasoningEffort: env.OPENAI_REASONING_EFFORT ?? 'high',
      maxOutputTokens: num(env.OPENAI_MAX_OUTPUT_TOKENS, 16000),
      timeoutMs: num(env.OPENAI_TIMEOUT_MS, 180_000),
      priceInputPerMTok: env.OPENAI_PRICE_INPUT_PER_MTOK ? Number(env.OPENAI_PRICE_INPUT_PER_MTOK) : null,
      priceOutputPerMTok: env.OPENAI_PRICE_OUTPUT_PER_MTOK ? Number(env.OPENAI_PRICE_OUTPUT_PER_MTOK) : null,
    },
    allowFixtures,
    workerInProcess: bool(env.WORKER_IN_PROCESS, mode !== 'production'),
    maxUploadBytes: num(env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024),
    maxImagePixels: num(env.MAX_IMAGE_PIXELS, 60_000_000),
    psa: { apiToken: env.PSA_API_TOKEN || null, baseUrl: env.PSA_API_BASE_URL ?? 'https://api.psacard.com/publicapi' },
    fx: { provider: (env.FX_PROVIDER as 'frankfurter' | 'none') ?? 'none', baseUrl: env.FX_BASE_URL ?? 'https://api.frankfurter.app' },
  };
}
