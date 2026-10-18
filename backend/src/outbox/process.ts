import { sql } from '../db';
import { type Handler, handlers as defaultHandlers } from './handlers';

const LEASE_SECONDS = 60;

interface Job {
  id: string;
  type: string;
  payload: any;
  attempts: number;
  max_attempts: number;
}

/**
 * Claims up to `limit` due jobs and runs them. Safe to call from many processes at once:
 * FOR UPDATE SKIP LOCKED gives each caller different rows. A job whose lease expired
 * (its worker died) is claimed again; handlers are idempotent, so that is harmless.
 *
 * The same function is triggered by the local worker loop, by an external scheduler on Vercel,
 * and opportunistically after write requests.
 */
export async function processOutboxBatch(limit = 20, handlers: Record<string, Handler> = defaultHandlers): Promise<number> {
  const jobs = await sql<Job[]>`
    update outbox set status = 'processing', attempts = attempts + 1,
      locked_until = now() + make_interval(secs => ${LEASE_SECONDS})
    where id in (
      select id from outbox
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and locked_until < now())
      order by id
      limit ${limit}
      for update skip locked
    )
    returning id, type, payload, attempts, max_attempts`;

  for (const job of jobs) {
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`No handler for job type "${job.type}"`);
      // The handler's writes and "done" commit together: either both happen or neither.
      await sql.begin(async (tx) => {
        await handler(tx, job.payload, { id: job.id, attempts: job.attempts });
        await tx`
          update outbox set status = 'done', processed_at = now(), locked_until = null, last_error = null
          where id = ${job.id}`;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = job.attempts >= job.max_attempts;
      // Exponential backoff: 2, 4, 8, 16 … seconds.
      await sql`
        update outbox set
          status = ${failed ? 'failed' : 'pending'},
          next_attempt_at = now() + make_interval(secs => ${2 ** job.attempts}),
          locked_until = null,
          last_error = ${message.slice(0, 2000)}
        where id = ${job.id}`;
      if (process.env.NODE_ENV !== 'test') {
        console.error(JSON.stringify({ msg: 'outbox job failed', jobId: job.id, type: job.type, attempts: job.attempts, failed, error: message }));
      }
    }
  }
  return jobs.length;
}

/** Drains everything currently due (bounded), e.g. for tests or a cron tick. */
export async function drainOutbox(maxBatches = 50, handlers?: Record<string, Handler>): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await processOutboxBatch(50, handlers);
    total += n;
    if (n === 0) break;
  }
  return total;
}
