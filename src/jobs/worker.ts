import { ModelError } from '../ai/client.js';
import type { AppContext } from '../context.js';
import { audit } from '../db.js';
import { PermanentError, runExtract, runValue } from './pipeline.js';
import { claimNext, complete, fail, type JobRow } from './queue.js';

export async function processJob(ctx: AppContext, job: JobRow): Promise<void> {
  try {
    if (job.kind === 'extract') await runExtract(ctx, job);
    else if (job.kind === 'value') await runValue(ctx, job);
    else throw new PermanentError('unknown_job', `Unknown job kind ${job.kind}`);
    await complete(ctx.db, job.id);
  } catch (e) {
    let code = 'internal';
    let retryable = true;
    if (e instanceof ModelError) {
      code = e.code;
      retryable = e.retryable;
    } else if (e instanceof PermanentError) {
      code = e.code;
      retryable = false;
    }
    const msg = (e as Error).message ?? String(e);
    const willRetry = await fail(ctx.db, job, code, msg, retryable);
    if (!willRetry && code !== 'needs_photos' && code !== 'card_missing') {
      await ctx.db.query(`UPDATE card_instances SET analysis_state='failed_retryable', updated_at=now() WHERE id=$1`, [job.card_id]);
    }
    await audit(ctx.db, job.user_id, job.card_id, 'job_error', { job_id: job.id, kind: job.kind, code, message: msg.slice(0, 500), willRetry }).catch(() => {});
    if (ctx.cfg.env !== 'test') console.error(`[worker] job ${job.id} (${job.kind}) failed: ${code}: ${msg}`);
  }
}

/** Drain all runnable jobs (used in tests and by the polling loop). */
export async function drain(ctx: AppContext, max = 50): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const job = await claimNext(ctx.db);
    if (!job) break;
    await processJob(ctx, job);
  }
  return n;
}

export function startWorkerLoop(ctx: AppContext, intervalMs = 1000) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await drain(ctx, 10);
    } catch (e) {
      console.error('[worker] loop error', e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return { kick: () => void tick(), stop: () => { stopped = true; clearInterval(timer); } };
}
