import type { ItemCard, ItemSummary, ItemType, StageKind, UserMini } from '@nops/shared';
import type { Sql } from '../db';
import type { Actor } from '../domain/actor';
import { describeEvent } from '../domain/describe';
import { loadUsers, loadWorkers, toUserMini } from './users';

/** Raw row shape produced by itemSelect(). */
export interface ItemRow {
  id: string;
  project_id: string;
  project_key: string;
  number: number;
  type: ItemType;
  title: string;
  description: string;
  priority: 1 | 2 | 3 | 4;
  stage_id: string;
  stage_name: string;
  stage_kind: StageKind;
  assignee_id: string | null;
  created_by: string;
  due_at: Date | null;
  next_action: string | null;
  next_action_due_at: Date | null;
  version: number;
  last_activity_at: Date;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
  delete_reason: string | null;
  is_overdue: boolean;
  is_blocked: boolean;
  awaiting_approval: boolean;
  open_blocker_count: number;
}

/**
 * Columns + derived flags for work items. Callers append their own joins/filters.
 * `m` (project_members of the caller) must be joined by the caller to scope visibility.
 */
export function itemColumns(db: Sql) {
  return db`
    i.id, i.project_id, p.key as project_key, i.number, i.type, i.title, i.description, i.priority,
    i.stage_id, s.name as stage_name, s.kind as stage_kind, i.assignee_id, i.created_by,
    i.due_at, i.next_action, i.next_action_due_at, i.version, i.last_activity_at,
    i.created_at, i.updated_at, i.deleted_at, i.deleted_by, i.delete_reason,
    (s.kind <> 'done' and i.due_at is not null and i.due_at < now()) as is_overdue,
    (select count(*)::int from item_links l
       join work_items b on b.id = l.blocker_item_id
       join workflow_stages bs on bs.id = b.stage_id
     where l.blocked_item_id = i.id and b.deleted_at is null and bs.kind <> 'done') as open_blocker_count,
    exists (select 1 from workflow_transitions t
              join workflow_stages ts on ts.id = t.to_stage_id
            where t.from_stage_id = i.stage_id and t.deleted_at is null
              and ts.deleted_at is null and ts.requires_approval) as awaiting_approval`;
}

export function itemFrom(db: Sql) {
  return db`
    from work_items i
    join workflow_stages s on s.id = i.stage_id
    join projects p on p.id = i.project_id`;
}

/** Join that restricts rows to projects the actor is a current member of. */
export function memberJoin(db: Sql, actor: Actor) {
  return db`join project_members m on m.project_id = i.project_id and m.user_id = ${actor.id} and m.valid_to is null`;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Turns rows into ItemSummary objects, batch-loading people. */
export async function hydrateSummaries(db: Sql, rows: ItemRow[]): Promise<ItemSummary[]> {
  if (rows.length === 0) return [];
  const [users, workers] = await Promise.all([
    loadUsers(db, rows.map((r) => r.created_by)),
    loadWorkers(
      db,
      rows.filter((r) => r.assignee_id).map((r) => ({ projectId: r.project_id, userId: r.assignee_id! })),
    ),
  ]);
  return rows.map((r) => {
    const creator = users.get(r.created_by);
    const summary: ItemSummary = {
      id: r.id,
      key: `${r.project_key}-${r.number}`,
      number: r.number,
      projectId: r.project_id,
      projectKey: r.project_key,
      type: r.type,
      title: r.title,
      priority: r.priority,
      stage: { id: r.stage_id, name: r.stage_name, kind: r.stage_kind },
      assignee: r.assignee_id ? (workers.get(`${r.project_id}:${r.assignee_id}`) ?? null) : null,
      createdBy: creator ? toUserMini(creator) : { id: r.created_by, fullName: 'Unknown', initials: '?', avatarColor: '#94a3b8' },
      dueAt: iso(r.due_at),
      nextAction: r.next_action,
      nextActionDueAt: iso(r.next_action_due_at),
      isBlocked: r.open_blocker_count > 0,
      awaitingApproval: r.awaiting_approval,
      isOverdue: r.is_overdue,
      version: r.version,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      lastActivityAt: r.last_activity_at.toISOString(),
    };
    if (r.deleted_at) {
      summary.deleted = true;
      summary.deletedAt = r.deleted_at.toISOString();
    }
    return summary;
  });
}

/** Cards for the canvas: summary + description excerpt, last change and note count. */
export async function hydrateCards(db: Sql, rows: ItemRow[]): Promise<ItemCard[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [summaries, lastEvents, noteCounts] = await Promise.all([
    hydrateSummaries(db, rows),
    db<{ item_id: string; type: string; data: any; actor_id: string | null; created_at: Date }[]>`
      select distinct on (item_id) item_id, type, data, actor_id, created_at
      from activity_events where item_id in ${db(ids)}
      order by item_id, id desc`,
    db<{ item_id: string; n: number }[]>`
      select item_id, count(*)::int as n from activity_events
      where item_id in ${db(ids)} and type = 'note.added' group by item_id`,
  ]);
  const actors = await loadUsers(db, lastEvents.map((e) => e.actor_id));
  const lastMap = new Map(lastEvents.map((e) => [e.item_id, e]));
  const noteMap = new Map(noteCounts.map((n) => [n.item_id, n.n]));
  return summaries.map((s, i) => {
    const ev = lastMap.get(s.id);
    const actor = ev?.actor_id ? actors.get(ev.actor_id) : undefined;
    const lastChange: ItemCard['lastChange'] = ev
      ? { actor: actor ? (toUserMini(actor) as UserMini) : null, summary: describeEvent(ev.type, ev.data), at: ev.created_at.toISOString() }
      : null;
    return {
      ...s,
      descriptionExcerpt: rows[i].description.slice(0, 140),
      lastChange,
      noteCount: noteMap.get(s.id) ?? 0,
    };
  });
}
