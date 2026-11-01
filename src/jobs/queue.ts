/**
 * Postgres-backed job queue with idempotency keys, bounded retries and
 * exponential backoff (§10, §11).
 */
import type { Queryable } from '../db.js';

export interface JobRow {
  id: string;
  card_id: string;
  user_id: string;
  kind: 'extract' | 'value';
  payload: Record<string, unknown>;
  state: string;
  stage: string | null;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  costs: unknown[];
}

export async function enqueue(db: Queryable, j: { cardId: string; userId: string; kind: JobRow['kind']; payload: Record<string, unknown>; idempotencyKey: string }): Promise<{ id: string; created: boolean }> {
  const ins = await db.query(
    `INSERT INTO analysis_jobs (card_id, user_id, kind, payload, idempotency_key) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [j.cardId, j.userId, j.kind, JSON.stringify(j.payload), j.idempotencyKey],
  );
  if (ins.rowCount) return { id: ins.rows[0].id, created: true };
  const ex = await db.query('SELECT id FROM analysis_jobs WHERE idempotency_key=$1', [j.idempotencyKey]);
  return { id: ex.rows[0].id, created: false };
}

export async function claimNext(db: Queryable): Promise<JobRow | null> {
  const r = await db.query(
    `UPDATE analysis_jobs SET state='running', locked_at=now(), attempts=attempts+1, updated_at=now()
     WHERE id = (
       SELECT id FROM analysis_jobs
       WHERE (state='queued' AND run_after <= now()) OR (state='running' AND locked_at < now() - interval '15 minutes')
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
  );
  return (r.rows[0] as JobRow) ?? null;
}

export async function setStage(db: Queryable, jobId: string, stage: string) {
  await db.query('UPDATE analysis_jobs SET stage=$2, updated_at=now() WHERE id=$1', [jobId, stage]);
}

export async function addCost(db: Queryable, jobId: string, usage: unknown) {
  await db.query(`UPDATE analysis_jobs SET costs = costs || $2::jsonb, updated_at=now() WHERE id=$1`, [jobId, JSON.stringify([usage])]);
}

export async function complete(db: Queryable, jobId: string) {
  await db.query(`UPDATE analysis_jobs SET state='done', locked_at=NULL, last_error=NULL, last_error_code=NULL, updated_at=now() WHERE id=$1`, [jobId]);
}

/** Returns true if the job will be retried. */
export async function fail(db: Queryable, job: JobRow, code: string, message: string, retryable: boolean): Promise<boolean> {
  const willRetry = retryable && job.attempts < job.max_attempts;
  const backoffSec = Math.min(300, 5 * 2 ** (job.attempts - 1));
  await db.query(
    `UPDATE analysis_jobs SET state=$2, locked_at=NULL, last_error_code=$3, last_error=$4, run_after = now() + ($5 || ' seconds')::interval, updated_at=now() WHERE id=$1`,
    [job.id, willRetry ? 'queued' : 'failed', code, message.slice(0, 2000), String(backoffSec)],
  );
  return willRetry;
}

export async function requeue(db: Queryable, jobId: string) {
  await db.query(`UPDATE analysis_jobs SET state='queued', attempts=0, run_after=now(), last_error=NULL, last_error_code=NULL, updated_at=now() WHERE id=$1 AND state='failed'`, [jobId]);
}
