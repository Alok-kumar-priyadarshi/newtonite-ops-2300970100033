import type { Tx } from '../db';
import { type Actor, actorRoleLabel } from '../domain/actor';
import { enqueue } from '../outbox/enqueue';

export interface NewEvent {
  projectId: string;
  itemId?: string | null;
  actor: Actor | null;
  type: string;
  data?: Record<string, unknown>;
  itemVersion?: number | null;
}

/**
 * Appends a history event and its outbox job in the caller's transaction.
 * This is the "change + activity + outbox in one transaction" rule: callers always run inside
 * the same `tx` that made the change, so all three commit or roll back together.
 */
export async function recordEvent(tx: Tx, e: NewEvent): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into activity_events (project_id, item_id, actor_id, actor_role, type, data, item_version)
    values (
      ${e.projectId}, ${e.itemId ?? null}, ${e.actor?.id ?? null}, ${actorRoleLabel(e.actor, e.projectId)},
      ${e.type}, ${tx.json((e.data ?? {}) as any)}, ${e.itemVersion ?? null}
    )
    returning id`;
  await enqueue(tx, 'event', { eventId: row.id });
  return row.id;
}
