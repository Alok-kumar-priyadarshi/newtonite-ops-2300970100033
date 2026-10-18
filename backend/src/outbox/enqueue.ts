import type { Tx } from '../db';

export type JobType = 'event' | 'canvas.changed';

/** Adds a background job in the caller's transaction (transactional outbox). */
export async function enqueue(tx: Tx, type: JobType, payload: Record<string, unknown>): Promise<void> {
  await tx`insert into outbox (type, payload) values (${type}, ${tx.json(payload as any)})`;
}
