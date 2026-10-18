import { sql } from '../db';

/**
 * Housekeeping run by the worker (every 10 minutes) and by the cron endpoint:
 * - idempotency keys are only needed while a client might retry, so they expire after 24 h;
 * - presence rows older than a day belong to closed tabs;
 * - finished outbox jobs are kept 7 days for debugging, failed ones until an Admin retries them.
 */
export async function cleanupExpired() {
  const [keys, presence, jobs] = await Promise.all([
    sql`delete from idempotency_keys where created_at < now() - interval '24 hours'`,
    sql`delete from presence where last_seen_at < now() - interval '1 day'`,
    sql`delete from outbox where status = 'done' and processed_at < now() - interval '7 days'`,
  ]);
  return { idempotencyKeys: keys.count, presence: presence.count, outboxJobs: jobs.count };
}
