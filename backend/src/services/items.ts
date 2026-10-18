import type { ActivityEvent, ItemDetail, ItemType, NoteKind } from '@nops/shared';
import { sql as rootSql, type Sql, type Tx } from '../db';
import { type Actor, roleIn } from '../domain/actor';
import { AppError, notFound } from '../domain/errors';
import { authorize, permissionsFor } from '../domain/permissions';
import { allowedTransitions, blockedTransitions, checkTransition } from '../domain/transitions';
import { recordEvent } from './activity';
import { hydrateSummaries, itemColumns, itemFrom, type ItemRow, memberJoin } from './item-queries';
import { loadUsers, toUserMini } from './users';
import { loadWorkflow } from './workflow';
import { decodeCursor, encodeCursor } from './cursor';

// ------------------------------------------------------------------ loading

interface LoadOptions {
  forUpdate?: boolean;
  /** Return deleted items instead of throwing 410 (used by GET for Managers and by restore). */
  allowDeleted?: boolean;
}

/** Loads an item visible to the actor (member of its project). 404 otherwise; 410 if deleted. */
export async function loadItemRow(db: Sql, actor: Actor, itemId: string, opts: LoadOptions = {}): Promise<ItemRow> {
  const [row] = await db<ItemRow[]>`
    select ${itemColumns(db)} ${itemFrom(db)} ${memberJoin(db, actor)}
    where i.id = ${itemId}
    ${opts.forUpdate ? db`for update of i` : db``}`;
  if (!row) throw notFound('Item');
  if (row.deleted_at && !opts.allowDeleted) throw await deletedError(db, row);
  return row;
}

async function deletedError(db: Sql, row: ItemRow) {
  const users = await loadUsers(db, [row.deleted_by]);
  const by = row.deleted_by ? users.get(row.deleted_by) : undefined;
  return new AppError(
    'ITEM_DELETED',
    `This item was deleted by ${by?.full_name ?? 'someone'}${row.delete_reason ? ` (${row.delete_reason})` : ''}.`,
    { deletedBy: by ? toUserMini(by) : null, deletedAt: row.deleted_at?.toISOString(), reason: row.delete_reason },
  );
}

/** Lightweight project lookup without locking, used to take the workflow lock first. */
async function projectOf(db: Sql, itemId: string): Promise<string> {
  const [r] = await db<{ project_id: string }[]>`select project_id from work_items where id = ${itemId}`;
  if (!r) throw notFound('Item');
  return r.project_id;
}

export async function itemDetail(db: Sql, actor: Actor, row: ItemRow): Promise<ItemDetail> {
  const [summary] = await hydrateSummaries(db, [row]);
  const [workflow, blockerRows, blockingRows, viewers, deletedBy] = await Promise.all([
    loadWorkflow(db, row.project_id),
    db<ItemRow[]>`
      select ${itemColumns(db)} ${itemFrom(db)}
      join item_links l on l.blocker_item_id = i.id
      where l.blocked_item_id = ${row.id} and i.deleted_at is null
      order by i.number`,
    db<ItemRow[]>`
      select ${itemColumns(db)} ${itemFrom(db)}
      join item_links l on l.blocked_item_id = i.id
      where l.blocker_item_id = ${row.id} and i.deleted_at is null
      order by i.number`,
    db<{ user_id: string }[]>`
      select user_id from presence
      where resource_type = 'item' and resource_id = ${row.id} and user_id <> ${actor.id}
        and last_seen_at > now() - interval '30 seconds'`,
    row.deleted_by ? loadUsers(db, [row.deleted_by]) : Promise.resolve(new Map()),
  ]);
  const viewerUsers = await loadUsers(db, viewers.map((v) => v.user_id));
  const res = { projectId: row.project_id, assigneeId: row.assignee_id };
  const detail: ItemDetail = {
    ...summary,
    description: row.description,
    blockers: await hydrateSummaries(db, blockerRows),
    blocking: await hydrateSummaries(db, blockingRows),
    permissions: row.deleted_at
      ? permissionsFor(actor, res).filter((p) => p === 'item.restore')
      : permissionsFor(actor, res),
    allowedTransitions: row.deleted_at
      ? []
      : allowedTransitions(workflow, toTransitionState(row), { id: actor.id, role: roleIn(actor, row.project_id) }),
    blockedTransitions: blockedTransitions(workflow, toTransitionState(row), { id: actor.id, role: roleIn(actor, row.project_id) }),
    viewers: [...viewerUsers.values()].map(toUserMini),
  };
  if (row.deleted_at) {
    const u = row.deleted_by ? deletedBy.get(row.deleted_by) : undefined;
    detail.deletedBy = u ? toUserMini(u) : null;
    detail.deleteReason = row.delete_reason;
  }
  return detail;
}

function toTransitionState(row: ItemRow) {
  return {
    stageId: row.stage_id,
    assigneeId: row.assignee_id,
    createdBy: row.created_by,
    version: row.version,
    deleted: !!row.deleted_at,
    openBlockerCount: row.open_blocker_count,
  };
}

export async function getItem(actor: Actor, itemId: string): Promise<ItemDetail> {
  const row = await loadItemRow(rootSql, actor, itemId, { allowDeleted: true });
  if (row.deleted_at && roleIn(actor, row.project_id) !== 'manager') throw await deletedError(rootSql, row);
  return itemDetail(rootSql, actor, row);
}

// ------------------------------------------------------------------ version conflicts

const FIELD_COLUMNS: Record<string, keyof ItemRow> = {
  title: 'title',
  description: 'description',
  type: 'type',
  dueAt: 'due_at',
  priority: 'priority',
  nextAction: 'next_action',
  nextActionDueAt: 'next_action_due_at',
};

/** 409 with the current item and every change made since the client's version. */
export async function versionConflict(db: Sql, actor: Actor, itemId: string, clientVersion: number): Promise<AppError> {
  const row = await loadItemRow(db, actor, itemId, { allowDeleted: true });
  if (row.deleted_at) return deletedError(db, row);
  const events = await db<{ id: string; type: string; data: any; actor_id: string | null; created_at: Date }[]>`
    select id, type, data, actor_id, created_at from activity_events
    where item_id = ${itemId} and item_version > ${clientVersion}
    order by id`;
  const users = await loadUsers(db, events.map((e) => e.actor_id));
  const changes = events.flatMap((e) => {
    const by = e.actor_id && users.get(e.actor_id) ? toUserMini(users.get(e.actor_id)!) : null;
    const base = { by, at: e.created_at.toISOString(), eventId: e.id };
    if (e.type === 'item.updated') {
      return Object.entries(e.data.changes ?? {}).map(([field, [from, to]]: [string, any]) => ({ ...base, field, from, to }));
    }
    if (['item.transitioned', 'item.approved', 'item.rejected', 'item.reopened'].includes(e.type)) {
      return [{ ...base, field: 'stage', from: e.data.from?.name, to: e.data.to?.name }];
    }
    if (['item.claimed', 'item.released', 'item.assigned'].includes(e.type)) {
      return [{ ...base, field: 'assignee', from: e.data.fromName ?? null, to: e.data.toName ?? null }];
    }
    return [{ ...base, field: e.type, from: null, to: null }];
  });
  const last = changes[changes.length - 1];
  const who = last?.by?.fullName ?? 'someone else';
  return new AppError('VERSION_CONFLICT', `This item was changed by ${who} while you were working on it.`, {
    current: await itemDetail(db, actor, row),
    changes,
  });
}

// ------------------------------------------------------------------ create

export interface CreateItemInput {
  projectId: string;
  type: ItemType;
  title: string;
  description: string;
  priority: number;
  dueAt?: string | null;
  assigneeId?: string | null;
}

async function assertCurrentMember(db: Sql, projectId: string, userId: string) {
  const [m] = await db`select 1 from project_members where project_id = ${projectId} and user_id = ${userId} and valid_to is null`;
  if (!m) throw new AppError('INVALID_ASSIGNEE', 'That person is not a member of this project.');
}

export async function createItem(tx: Tx, actor: Actor, input: CreateItemInput): Promise<ItemDetail> {
  const role = roleIn(actor, input.projectId);
  if (!role) throw notFound('Project');
  authorize(actor, 'item.create', { projectId: input.projectId });
  if (input.assigneeId && input.assigneeId !== actor.id) {
    if (role === 'member') {
      throw new AppError('LEAD_OR_MANAGER_REQUIRED', 'Members can only assign new items to themselves.');
    }
    await assertCurrentMember(tx, input.projectId, input.assigneeId);
  }
  // Atomic per-project counter: concurrent creates queue on this row and get distinct numbers.
  const [{ number }] = await tx<{ number: number }[]>`
    update projects set next_item_number = next_item_number + 1
    where id = ${input.projectId} returning next_item_number - 1 as number`;
  const [start] = await tx<{ id: string }[]>`
    select id from workflow_stages where project_id = ${input.projectId} and kind = 'start' and deleted_at is null`;
  if (!start) throw new AppError('WORKFLOW_INVALID', 'This project has no start stage.', { reason: 'START_STAGE' });

  const [{ id }] = await tx<{ id: string }[]>`
    insert into work_items (project_id, number, type, title, description, priority, stage_id, assignee_id, created_by, due_at)
    values (${input.projectId}, ${number}, ${input.type}, ${input.title}, ${input.description}, ${input.priority},
            ${start.id}, ${input.assigneeId ?? null}, ${actor.id}, ${input.dueAt ?? null})
    returning id`;
  await recordEvent(tx, {
    projectId: input.projectId,
    itemId: id,
    actor,
    type: 'item.created',
    data: { title: input.title, type: input.type, priority: input.priority, assigneeId: input.assigneeId ?? null },
    itemVersion: 1,
  });
  return itemDetail(tx, actor, await loadItemRow(tx, actor, id));
}

// ------------------------------------------------------------------ update fields

export interface PatchItemInput {
  version: number;
  title?: string;
  description?: string;
  type?: ItemType;
  dueAt?: string | null;
  priority?: number;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  reason?: string;
}

const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v).toISOString() : v);

export async function patchItem(tx: Tx, actor: Actor, itemId: string, input: PatchItemInput): Promise<ItemDetail> {
  const row = await loadItemRow(tx, actor, itemId, { forUpdate: true });
  const res = { projectId: row.project_id, assigneeId: row.assignee_id };

  const changes: Record<string, [unknown, unknown]> = {};
  for (const field of Object.keys(FIELD_COLUMNS)) {
    const next = (input as any)[field];
    if (next === undefined) continue;
    const prev = norm(row[FIELD_COLUMNS[field]]);
    if (norm(next) !== prev) changes[field] = [prev, norm(next)];
  }

  const touched = Object.keys(changes);
  if (touched.some((f) => ['title', 'description', 'type', 'dueAt'].includes(f))) authorize(actor, 'item.edit_details', res);
  if (touched.includes('priority')) {
    authorize(actor, 'item.edit_priority', res);
    if (!input.reason?.trim()) throw new AppError('REASON_REQUIRED', 'Please give a reason for changing the priority.');
  }
  if (touched.some((f) => f === 'nextAction' || f === 'nextActionDueAt')) authorize(actor, 'item.edit_next_action', res);

  if (row.version !== input.version) throw await versionConflict(tx, actor, itemId, input.version);
  if (touched.length === 0) return itemDetail(tx, actor, row);

  const v = (field: string) => (field in changes ? changes[field][1] : norm(row[FIELD_COLUMNS[field]]));
  const [{ version }] = await tx<{ version: number }[]>`
    update work_items set
      title = ${v('title') as string}, description = ${v('description') as string}, type = ${v('type') as string},
      due_at = ${v('dueAt') as string | null}, priority = ${v('priority') as number},
      next_action = ${v('nextAction') as string | null}, next_action_due_at = ${v('nextActionDueAt') as string | null},
      version = version + 1, updated_at = now(), last_activity_at = now()
    where id = ${itemId} and version = ${input.version}
    returning version`;
  await recordEvent(tx, {
    projectId: row.project_id,
    itemId,
    actor,
    type: 'item.updated',
    data: { changes, reason: input.reason ?? null },
    itemVersion: version,
  });
  return itemDetail(tx, actor, await loadItemRow(tx, actor, itemId));
}

// ------------------------------------------------------------------ ownership

export async function claimItem(tx: Tx, actor: Actor, itemId: string): Promise<ItemDetail> {
  // One conditional statement: the database decides the winner. A concurrent claimer waits on the
  // row lock, then re-evaluates `assignee_id is null` against the committed row and updates nothing.
  const won = await tx<{ project_id: string; version: number }[]>`
    update work_items i set assignee_id = ${actor.id}, version = i.version + 1, updated_at = now(), last_activity_at = now()
    from project_members m
    where i.id = ${itemId} and i.assignee_id is null and i.deleted_at is null
      and m.project_id = i.project_id and m.user_id = ${actor.id} and m.valid_to is null
    returning i.project_id, i.version`;

  if (won.length === 0) {
    const row = await loadItemRow(tx, actor, itemId); // 404 / 410
    if (row.assignee_id === actor.id) return itemDetail(tx, actor, row); // already yours
    const users = await loadUsers(tx, [row.assignee_id]);
    const owner = row.assignee_id ? users.get(row.assignee_id) : undefined;
    throw new AppError('ALREADY_CLAIMED', `${owner?.full_name ?? 'Someone'} already claimed this item.`, {
      assignee: owner ? toUserMini(owner) : null,
      claimedAt: row.updated_at.toISOString(),
    });
  }
  const { project_id, version } = won[0];
  authorize(actor, 'item.claim', { projectId: project_id });
  await recordEvent(tx, {
    projectId: project_id,
    itemId,
    actor,
    type: 'item.claimed',
    data: { toName: actor.fullName, to: actor.id },
    itemVersion: version,
  });
  return itemDetail(tx, actor, await loadItemRow(tx, actor, itemId));
}

export async function releaseItem(tx: Tx, actor: Actor, itemId: string, input: { version: number }) {
  const row = await loadItemRow(tx, actor, itemId, { forUpdate: true });
  authorize(actor, 'item.release', { projectId: row.project_id, assigneeId: row.assignee_id });
  if (row.version !== input.version) throw await versionConflict(tx, actor, itemId, input.version);
  if (!row.assignee_id) return itemDetail(tx, actor, row);
  const users = await loadUsers(tx, [row.assignee_id]);
  const [{ version }] = await tx<{ version: number }[]>`
    update work_items set assignee_id = null, version = version + 1, updated_at = now(), last_activity_at = now()
    where id = ${itemId} returning version`;
  await recordEvent(tx, {
    projectId: row.project_id,
    itemId,
    actor,
    type: 'item.released',
    data: { from: row.assignee_id, fromName: users.get(row.assignee_id)?.full_name ?? null },
    itemVersion: version,
  });
  return itemDetail(tx, actor, await loadItemRow(tx, actor, itemId));
}

export async function assignItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
  input: { version: number; assigneeId: string | null; reason: string },
) {
  const row = await loadItemRow(tx, actor, itemId, { forUpdate: true });
  authorize(actor, 'item.assign', { projectId: row.project_id, assigneeId: row.assignee_id });
  if (input.assigneeId) await assertCurrentMember(tx, row.project_id, input.assigneeId);
  if (row.version !== input.version) throw await versionConflict(tx, actor, itemId, input.version);
  if (row.assignee_id === input.assigneeId) return itemDetail(tx, actor, row);
  const users = await loadUsers(tx, [row.assignee_id, input.assigneeId]);
  const [{ version }] = await tx<{ version: number }[]>`
    update work_items set assignee_id = ${input.assigneeId}, version = version + 1, updated_at = now(), last_activity_at = now()
    where id = ${itemId} returning version`;
  await recordEvent(tx, {
    projectId: row.project_id,
    itemId,
    actor,
    type: 'item.assigned',
    data: {
      from: row.assignee_id,
      fromName: row.assignee_id ? (users.get(row.assignee_id)?.full_name ?? null) : null,
      to: input.assigneeId,
      toName: input.assigneeId ? (users.get(input.assigneeId)?.full_name ?? null) : null,
      reason: input.reason,
    },
    itemVersion: version,
  });
  return itemDetail(tx, actor, await loadItemRow(tx, actor, itemId));
}

// ------------------------------------------------------------------ workflow moves

export async function transitionItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
  input: { version: number; toStageId: string; reason?: string },
) {
  const projectId = await projectOf(tx, itemId);
  // Shared lock on the workflow: transitions run in parallel with each other, but a workflow edit
  // (which takes FOR UPDATE) waits for us, so we never move along a connection being deleted.
  await tx`select 1 from workflows where project_id = ${projectId} for share`;
  const row = await loadItemRow(tx, actor, itemId, { forUpdate: true });
  authorize(actor, 'item.transition', { projectId: row.project_id, assigneeId: row.assignee_id });

  const workflow = await loadWorkflow(tx, row.project_id);
  let decision;
  try {
    decision = checkTransition(workflow, toTransitionState(row), { id: actor.id, role: roleIn(actor, row.project_id) }, input);
  } catch (err) {
    if (err instanceof AppError && err.code === 'VERSION_CONFLICT') throw await versionConflict(tx, actor, itemId, input.version);
    if (err instanceof AppError && err.code === 'BLOCKED_BY_OPEN_ITEMS') {
      const blockers = await tx<{ key: string }[]>`
        select p.key || '-' || b.number as key from item_links l
        join work_items b on b.id = l.blocker_item_id join workflow_stages bs on bs.id = b.stage_id
        join projects p on p.id = b.project_id
        where l.blocked_item_id = ${itemId} and b.deleted_at is null and bs.kind <> 'done'`;
      throw new AppError(err.code, `Blocked by ${blockers.map((b) => b.key).join(', ')}. Resolve them first.`, {
        blockers: blockers.map((b) => b.key),
      });
    }
    throw err;
  }

  const [{ version }] = await tx<{ version: number }[]>`
    update work_items set stage_id = ${decision.to.id}, version = version + 1, updated_at = now(), last_activity_at = now()
    where id = ${itemId} and version = ${input.version}
    returning version`;

  // Mention which items this unblocks (shown in notifications).
  let unblocks: string[] = [];
  if (decision.to.kind === 'done') {
    unblocks = (
      await tx<{ key: string }[]>`
        select p.key || '-' || w.number as key from item_links l
        join work_items w on w.id = l.blocked_item_id join projects p on p.id = w.project_id
        where l.blocker_item_id = ${itemId} and w.deleted_at is null`
    ).map((r) => r.key);
  }
  await recordEvent(tx, {
    projectId: row.project_id,
    itemId,
    actor,
    type: decision.eventType,
    data: {
      from: { id: decision.from.id, name: decision.from.name, kind: decision.from.kind },
      to: { id: decision.to.id, name: decision.to.name, kind: decision.to.kind },
      transitionId: decision.transition.id,
      reason: input.reason ?? null,
      unblocks,
    },
    itemVersion: version,
  });
  return itemDetail(tx, actor, await loadItemRow(tx, actor, itemId));
}

// ------------------------------------------------------------------ delete / restore

export async function deleteItem(tx: Tx, actor: Actor, itemId: string, input: { version: number; reason: string }) {
  const row = await loadItemRow(tx, actor, itemId, { forUpdate: true });
  authorize(actor, 'item.delete', { projectId: row.project_id, assigneeId: row.assignee_id });
  if (row.version !== input.version) throw await versionConflict(tx, actor, itemId, input.version);
  // Soft delete: the item leaves every view, but its history stays and it can be restored.
  const [{ version, deleted_at }] = await tx<{ version: number; deleted_at: Date }[]>`
    update work_items set deleted_at = now(), deleted_by = ${actor.id}, delete_reason = ${input.reason},
      version = version + 1, updated_at = now(), last_activity_at = now()
    where id = ${itemId} returning version, deleted_at`;
  await recordEvent(tx, {
    projectId: row.project_id,
    itemId,
    actor,
    type: 'item.deleted',
    data: { reason: input.reason, key: `${row.project_key}-${row.number}`, title: row.title },
    itemVersion: version,
  });
  return { deleted: true, deletedAt: deleted_at.toISOString() };
}

export async function restoreItem(tx: Tx, actor: Actor, itemId: string, input: { reason: string }) {
  const row = await loadItemRow(tx, actor, itemId, { forUpdate: true, allowDeleted: true });
  authorize(actor, 'item.restore', { projectId: row.project_id });
  if (!row.deleted_at) return itemDetail(tx, actor, row);
  // If its stage was removed while it was deleted, it goes back to the start stage.
  const [stageAlive] = await tx`select 1 from workflow_stages where id = ${row.stage_id} and deleted_at is null`;
  const [{ version }] = await tx<{ version: number }[]>`
    update work_items set deleted_at = null, deleted_by = null, delete_reason = null,
      stage_id = ${stageAlive ? row.stage_id : tx`(select id from workflow_stages where project_id = ${row.project_id} and kind = 'start' and deleted_at is null)`},
      version = version + 1, updated_at = now(), last_activity_at = now()
    where id = ${itemId} returning version`;
  await recordEvent(tx, {
    projectId: row.project_id,
    itemId,
    actor,
    type: 'item.restored',
    data: { reason: input.reason },
    itemVersion: version,
  });
  return itemDetail(tx, actor, await loadItemRow(tx, actor, itemId));
}

export async function listDeletedItems(actor: Actor, projectId: string, page: { limit: number; cursor?: string }) {
  authorize(actor, 'item.restore', { projectId });
  const c = decodeCursor(page.cursor) as [string, string] | null;
  const rows = await rootSql<ItemRow[]>`
    select ${itemColumns(rootSql)} ${itemFrom(rootSql)}
    where i.project_id = ${projectId} and i.deleted_at is not null
      ${c ? rootSql`and (i.deleted_at, i.id) < (${c[0]}::timestamptz, ${c[1]}::uuid)` : rootSql``}
    order by i.deleted_at desc, i.id desc
    limit ${page.limit + 1}`;
  const more = rows.length > page.limit;
  const pageRows = rows.slice(0, page.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: await hydrateSummaries(rootSql, pageRows),
    nextCursor: more && last ? encodeCursor([last.deleted_at!.toISOString(), last.id]) : null,
  };
}

// ------------------------------------------------------------------ notes & links

export async function addNote(tx: Tx, actor: Actor, itemId: string, input: { kind: NoteKind; body: string }) {
  const row = await loadItemRow(tx, actor, itemId);
  authorize(actor, 'item.comment', { projectId: row.project_id });
  // A note is history, not a field change: no version bump, so it never conflicts with edits.
  await tx`update work_items set last_activity_at = now() where id = ${itemId}`;
  const eventId = await recordEvent(tx, {
    projectId: row.project_id,
    itemId,
    actor,
    type: 'note.added',
    data: { kind: input.kind, body: input.body },
    itemVersion: row.version,
  });
  const [event] = await activityRows(tx, activityFilter(tx, { eventId }));
  return { event };
}

export async function addLink(tx: Tx, actor: Actor, itemId: string, input: { blockerItemId: string }) {
  const row = await loadItemRow(tx, actor, itemId);
  authorize(actor, 'item.link', { projectId: row.project_id });
  const blocker = await loadItemRow(tx, actor, input.blockerItemId).catch(() => {
    throw new AppError('NOT_FOUND', 'Blocking item not found in this project.');
  });
  if (blocker.project_id !== row.project_id) throw new AppError('NOT_FOUND', 'Blocking item not found in this project.');
  if (blocker.id === row.id) throw new AppError('DEPENDENCY_CYCLE', 'An item cannot block itself.');

  // Serialize link edits per project so two opposite links can't both pass the cycle check.
  await tx`select pg_advisory_xact_lock(hashtext(${'links:' + row.project_id}))`;
  const [cycle] = await tx`
    with recursive downstream(id) as (
      select blocked_item_id from item_links where blocker_item_id = ${row.id}
      union
      select l.blocked_item_id from item_links l join downstream d on l.blocker_item_id = d.id
    )
    select 1 from downstream where id = ${blocker.id} limit 1`;
  if (cycle) {
    throw new AppError(
      'DEPENDENCY_CYCLE',
      `${blocker.project_key}-${blocker.number} already depends on this item, so it can't also block it.`,
    );
  }
  const inserted = await tx`
    insert into item_links (project_id, blocker_item_id, blocked_item_id, created_by)
    values (${row.project_id}, ${blocker.id}, ${row.id}, ${actor.id})
    on conflict (blocker_item_id, blocked_item_id) do nothing
    returning id`;
  if (inserted.length > 0) {
    await tx`update work_items set updated_at = now(), last_activity_at = now() where id = ${row.id}`;
    await recordEvent(tx, {
      projectId: row.project_id,
      itemId: row.id,
      actor,
      type: 'item.link_added',
      data: { blockerItemId: blocker.id, blockerKey: `${blocker.project_key}-${blocker.number}` },
      itemVersion: row.version,
    });
  }
  return itemDetail(tx, actor, await loadItemRow(tx, actor, itemId));
}

export async function removeLink(tx: Tx, actor: Actor, itemId: string, blockerItemId: string) {
  const row = await loadItemRow(tx, actor, itemId);
  authorize(actor, 'item.link', { projectId: row.project_id });
  const removed = await tx<{ key: string }[]>`
    delete from item_links l using work_items b, projects p
    where l.blocked_item_id = ${row.id} and l.blocker_item_id = ${blockerItemId}
      and b.id = l.blocker_item_id and p.id = b.project_id
    returning p.key || '-' || b.number as key`;
  if (removed.length > 0) {
    await tx`update work_items set updated_at = now(), last_activity_at = now() where id = ${row.id}`;
    await recordEvent(tx, {
      projectId: row.project_id,
      itemId: row.id,
      actor,
      type: 'item.link_removed',
      data: { blockerItemId, blockerKey: removed[0].key },
      itemVersion: row.version,
    });
  }
}

// ------------------------------------------------------------------ activity

interface ActivityRow {
  id: string;
  type: string;
  actor_id: string | null;
  actor_role: string;
  data: any;
  item_version: number | null;
  created_at: Date;
  item_id: string | null;
  item_number: number | null;
  item_title: string | null;
  project_id: string;
  project_key: string;
  project_name: string;
}

type ActivityFilter = ReturnType<typeof activityFilter>;

/** Builds a WHERE fragment for activity queries. */
export function activityFilter(
  db: Sql,
  f: { eventId?: string; itemId?: string; actorId?: string; projectIds?: string[]; kind?: string; before?: string },
) {
  const parts = [db`true`];
  if (f.eventId) parts.push(db`a.id = ${f.eventId}`);
  if (f.itemId) parts.push(db`a.item_id = ${f.itemId}`);
  if (f.actorId) parts.push(db`a.actor_id = ${f.actorId}`);
  if (f.projectIds) parts.push(f.projectIds.length ? db`a.project_id in ${db(f.projectIds)}` : db`false`);
  if (f.before) parts.push(db`a.id < ${f.before}`);
  switch (f.kind) {
    case 'notes':
      parts.push(db`a.type = 'note.added'`);
      break;
    case 'changes':
      parts.push(db`a.type <> 'note.added'`);
      break;
    case 'decisions':
      parts.push(db`a.type = 'note.added' and a.data->>'kind' = 'decision'`);
      break;
    case 'approvals':
      parts.push(db`a.type in ('item.approved', 'item.rejected')`);
      break;
  }
  return parts.reduce((acc, p) => db`${acc} and ${p}`);
}

export async function activityRows(db: Sql, where: ActivityFilter, limit = 50): Promise<ActivityEvent[]> {
  const rows = await db<ActivityRow[]>`
    select a.id, a.type, a.actor_id, a.actor_role, a.data, a.item_version, a.created_at, a.item_id,
           w.number as item_number, w.title as item_title, a.project_id, p.key as project_key, p.name as project_name
    from activity_events a
    join projects p on p.id = a.project_id
    left join work_items w on w.id = a.item_id
    where ${where}
    order by a.id desc
    limit ${limit}`;
  const users = await loadUsers(db, rows.map((r) => r.actor_id));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    actor: r.actor_id && users.get(r.actor_id) ? toUserMini(users.get(r.actor_id)!) : null,
    actorRole: r.actor_role,
    data: r.data,
    itemVersion: r.item_version,
    createdAt: r.created_at.toISOString(),
    item: r.item_id ? { id: r.item_id, key: `${r.project_key}-${r.item_number}`, title: r.item_title ?? '' } : null,
    project: { id: r.project_id, key: r.project_key, name: r.project_name },
  }));
}

export async function listItemActivity(actor: Actor, itemId: string, q: { filter: string; limit: number; cursor?: string }) {
  await loadItemRow(rootSql, actor, itemId, { allowDeleted: true }); // visibility check
  const before = decodeCursor(q.cursor) as string | null;
  const items = await activityRows(
    rootSql,
    activityFilter(rootSql, { itemId, kind: q.filter, before: before ?? undefined }),
    q.limit + 1,
  );
  const more = items.length > q.limit;
  const page = items.slice(0, q.limit);
  return { items: page, nextCursor: more ? encodeCursor(page[page.length - 1].id) : null };
}
