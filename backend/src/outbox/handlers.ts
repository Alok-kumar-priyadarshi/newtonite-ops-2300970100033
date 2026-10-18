import type { Tx } from '../db';
import { notificationTitle } from '../domain/describe';

export type Handler = (tx: Tx, payload: any, job: { id: string; attempts: number }) => Promise<void>;

/**
 * Every handler must be idempotent: a job can run more than once (worker crash after the work but
 * before marking it done, or an expired lease). Unique constraints make repeats harmless.
 */

/** One activity event → notify every other current project member, and update profile stats. */
const event: Handler = async (tx, payload) => {
  const [ev] = await tx<
    { id: string; project_id: string; item_id: string | null; actor_id: string | null; type: string; data: any; actor_name: string | null; item_key: string | null }[]
  >`
    select a.id, a.project_id, a.item_id, a.actor_id, a.type, a.data, u.full_name as actor_name,
           case when w.id is not null then p.key || '-' || w.number end as item_key
    from activity_events a
    join projects p on p.id = a.project_id
    left join users u on u.id = a.actor_id
    left join work_items w on w.id = a.item_id
    where a.id = ${payload.eventId}`;
  if (!ev) return; // nothing to do (should not happen: the event commits with the job)

  // Recipients are computed now, not when the event happened: removed members are not notified.
  const title = notificationTitle(ev.actor_name ?? 'System', ev.type, ev.data, ev.item_key);
  await tx`
    insert into notifications (recipient_id, project_id, item_id, actor_id, type, title, source_event_id)
    select m.user_id, ${ev.project_id}, ${ev.item_id}, ${ev.actor_id}, ${ev.type}, ${title}, ${ev.id}
    from project_members m
    where m.project_id = ${ev.project_id} and m.valid_to is null
      and m.user_id is distinct from ${ev.actor_id}
    on conflict (recipient_id, source_event_id) where source_event_id is not null do nothing`;

  await updateStats(tx, ev);
};

async function updateStats(tx: Tx, ev: { id: string; project_id: string; actor_id: string | null; type: string; data: any }) {
  if (!ev.actor_id) return;
  const delta = {
    claimed: ev.type === 'item.claimed' ? 1 : 0,
    // Finishing counts once: moving between two done stages (Closed → Archive) is not a new resolution.
    resolved:
      ['item.transitioned', 'item.approved'].includes(ev.type) && ev.data?.to?.kind === 'done' && ev.data?.from?.kind !== 'done'
        ? 1
        : 0,
    approved: ev.type === 'item.approved' ? 1 : 0,
    notes: ev.type === 'note.added' ? 1 : 0,
  };
  if (!delta.claimed && !delta.resolved && !delta.approved && !delta.notes) return;
  // Count each event at most once, in the same transaction as the increment.
  const first = await tx`insert into processed_stat_events (event_id) values (${ev.id}) on conflict do nothing returning event_id`;
  if (first.length === 0) return;
  await tx`
    insert into user_project_stats (user_id, project_id, claimed, resolved, approved, notes)
    values (${ev.actor_id}, ${ev.project_id}, ${delta.claimed}, ${delta.resolved}, ${delta.approved}, ${delta.notes})
    on conflict (user_id, project_id) do update set
      claimed = user_project_stats.claimed + excluded.claimed,
      resolved = user_project_stats.resolved + excluded.resolved,
      approved = user_project_stats.approved + excluded.approved,
      notes = user_project_stats.notes + excluded.notes,
      updated_at = now()`;
}

/**
 * Canvas drawing edits → one grouped notification per editor per 10-minute window.
 * The digest row is upserted; each job is recorded once in notification_sources, so the
 * displayed count ("12 changes") is exact even when a job is retried.
 */
const canvasChanged: Handler = async (tx, payload, job) => {
  const { projectId, actorId, windowStart } = payload as { projectId: string; actorId: string; windowStart: number };
  const [actor] = await tx<{ full_name: string }[]>`select full_name from users where id = ${actorId}`;
  const [project] = await tx<{ name: string }[]>`select name from projects where id = ${projectId}`;
  if (!actor || !project) return;
  const digestKey = `canvas:${projectId}:${actorId}:${windowStart}`;
  const title = `${actor.full_name} edited the ${project.name} canvas`;
  const rows = await tx<{ id: string }[]>`
    insert into notifications (recipient_id, project_id, actor_id, type, title, digest_key)
    select m.user_id, ${projectId}, ${actorId}, 'canvas.digest', ${title}, ${digestKey}
    from project_members m
    where m.project_id = ${projectId} and m.valid_to is null and m.user_id <> ${actorId}
    on conflict (recipient_id, digest_key) where digest_key is not null
    do update set created_at = now(), read_at = null
    returning id`;
  if (rows.length === 0) return;
  await tx`
    insert into notification_sources (notification_id, source_ref)
    select unnest(${tx.array(rows.map((r) => r.id), 20)}::bigint[]), ${'outbox:' + job.id}
    on conflict do nothing`;
};

export const handlers: Record<string, Handler> = {
  event,
  'canvas.changed': canvasChanged,
};
