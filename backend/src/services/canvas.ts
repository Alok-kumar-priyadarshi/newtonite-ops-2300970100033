import { type CanvasData, type CanvasElement, type CanvasElementType, type ChangesFeed, LIMITS } from '@nops/shared';
import { sql as rootSql, type Sql, type Tx } from '../db';
import type { Actor } from '../domain/actor';
import { AppError } from '../domain/errors';
import { authorize } from '../domain/permissions';
import { enqueue } from '../outbox/enqueue';
import { decodeCursor, encodeCursor } from './cursor';
import { hydrateCards, itemColumns, itemFrom, type ItemRow } from './item-queries';
import { getProject, getProjectSummary, listMembers, requireMember } from './projects';
import { loadUsers, toUserMini } from './users';
import { loadWorkflow } from './workflow';

interface ElementRow {
  id: string;
  project_id: string;
  type: CanvasElementType;
  stage_id: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  props: Record<string, any>;
  version: number;
  created_by: string;
  updated_by: string | null;
  updated_at: Date;
  deleted_at: Date | null;
}

const ELEMENT_COLUMNS = (db: Sql) =>
  db`id, project_id, type, stage_id, x, y, width, height, z_index, props, version, created_by, updated_by, updated_at, deleted_at`;

async function toElements(db: Sql, rows: ElementRow[]): Promise<CanvasElement[]> {
  const users = await loadUsers(db, rows.map((r) => r.updated_by));
  return rows.map((r) => {
    const u = r.updated_by ? users.get(r.updated_by) : undefined;
    const el: CanvasElement = {
      id: r.id,
      projectId: r.project_id,
      type: r.type,
      stageId: r.stage_id,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      zIndex: r.z_index,
      props: r.props,
      version: r.version,
      updatedBy: u ? toUserMini(u) : null,
      updatedAt: r.updated_at.toISOString(),
    };
    if (r.deleted_at) el.deleted = true;
    return el;
  });
}

/** Top-N cards per stage via one LATERAL query (uses the (project, stage, priority, due) index). */
async function stageCards(db: Sql, projectId: string) {
  const [rows, counts] = await Promise.all([
    db<ItemRow[]>`
      select x.* from workflow_stages st
      cross join lateral (
        select ${itemColumns(db)} ${itemFrom(db)}
        where i.stage_id = st.id and i.deleted_at is null
        order by i.priority, coalesce(i.due_at, 'infinity'::timestamptz), i.id
        limit ${LIMITS.stageCardsOnCanvas}
      ) x
      where st.project_id = ${projectId} and st.deleted_at is null`,
    stageCounts(db, projectId),
  ]);
  const cards = await hydrateCards(db, rows);
  const byStage = new Map<string, typeof cards>();
  for (const c of cards) byStage.set(c.stage.id, [...(byStage.get(c.stage.id) ?? []), c]);
  return { byStage, counts };
}

async function stageCounts(db: Sql, projectId: string): Promise<Record<string, number>> {
  const rows = await db<{ stage_id: string; n: number }[]>`
    select stage_id, count(*)::int as n from work_items
    where project_id = ${projectId} and deleted_at is null group by stage_id`;
  return Object.fromEntries(rows.map((r) => [r.stage_id, r.n]));
}

export async function getCanvas(actor: Actor, projectId: string): Promise<CanvasData> {
  requireMember(actor, projectId);
  const db = rootSql;
  const [project, elementRows, cards, members, [{ now }]] = await Promise.all([
    getProject(db, actor, projectId), // includes the workflow
    db<ElementRow[]>`select ${ELEMENT_COLUMNS(db)} from canvas_elements where project_id = ${projectId} and deleted_at is null`,
    stageCards(db, projectId),
    listMembers(actor, projectId),
    db<{ now: Date }[]>`select now() as now`,
  ]);
  const workflow = project.workflow;
  return {
    project,
    workflow,
    elements: await toElements(db, elementRows),
    stages: workflow.stages.map((s) => ({
      stageId: s.id,
      count: cards.counts[s.id] ?? 0,
      items: cards.byStage.get(s.id) ?? [],
    })),
    members: members.map((m) => m.user),
    serverTime: now.toISOString(),
  };
}

export async function listStageItems(actor: Actor, projectId: string, stageId: string, page: { limit: number; cursor?: string }) {
  requireMember(actor, projectId);
  const db = rootSql;
  const c = decodeCursor(page.cursor) as [number, string, string] | null;
  const rows = await db<ItemRow[]>`
    select ${itemColumns(db)} ${itemFrom(db)}
    where i.project_id = ${projectId} and i.stage_id = ${stageId} and i.deleted_at is null
      ${c ? db`and (i.priority, coalesce(i.due_at, 'infinity'::timestamptz), i.id) > (${c[0]}::int, ${String(c[1])}::text::timestamptz, ${c[2]}::uuid)` : db``}
    order by i.priority, coalesce(i.due_at, 'infinity'::timestamptz), i.id
    limit ${page.limit + 1}`;
  const more = rows.length > page.limit;
  const pageRows = rows.slice(0, page.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: await hydrateCards(db, pageRows),
    nextCursor: more && last ? encodeCursor([last.priority, last.due_at?.toISOString() ?? 'infinity', last.id]) : null,
  };
}

/**
 * "What changed since T". Returns rows updated after T − 30 s: a transaction that started before T
 * but committed after it carries an `updated_at` earlier than T, and statement_timeout (10 s) bounds
 * how late that can be. Clients merge by version, so receiving a row twice is harmless.
 */
export async function getChanges(actor: Actor, projectId: string, since: string): Promise<ChangesFeed> {
  requireMember(actor, projectId);
  const db = rootSql;
  const from = new Date(new Date(since).getTime() - 30_000);
  const MAX_ITEMS = 500;
  const MAX_ELEMENTS = 1000;
  const [[{ now }], itemRows, elementRows, [wf], [proj], counts] = await Promise.all([
    db<{ now: Date }[]>`select now() as now`,
    db<ItemRow[]>`
      select ${itemColumns(db)} ${itemFrom(db)}
      where i.project_id = ${projectId} and i.updated_at > ${from}
      order by i.updated_at limit ${MAX_ITEMS + 1}`,
    db<ElementRow[]>`
      select ${ELEMENT_COLUMNS(db)} from canvas_elements
      where project_id = ${projectId} and updated_at > ${from}
      order by updated_at limit ${MAX_ELEMENTS + 1}`,
    db<{ updated_at: Date }[]>`select updated_at from workflows where project_id = ${projectId}`,
    db<{ updated_at: Date }[]>`select updated_at from projects where id = ${projectId}`,
    stageCounts(db, projectId),
  ]);
  const resync = itemRows.length > MAX_ITEMS || elementRows.length > MAX_ELEMENTS;
  return {
    serverTime: now.toISOString(),
    items: resync ? [] : await hydrateCards(db, itemRows),
    elements: resync ? [] : await toElements(db, elementRows),
    workflow: wf && wf.updated_at > from ? await loadWorkflow(db, projectId) : null,
    project: proj && proj.updated_at > from ? await getProjectSummary(db, actor, projectId) : null,
    stageCounts: counts,
    resync,
  };
}

// ------------------------------------------------------------------ writes

function canvasGuard(actor: Actor, projectId: string) {
  requireMember(actor, projectId);
  authorize(actor, 'canvas.edit', { projectId });
}

/** One grouped notification per editor per 10-minute window (see outbox/handlers.ts). */
async function enqueueCanvasDigest(tx: Tx, actor: Actor, projectId: string, changes: number) {
  const windowStart = Math.floor(Date.now() / 600_000) * 600_000;
  await enqueue(tx, 'canvas.changed', { projectId, actorId: actor.id, windowStart, changes });
}

export interface NewElement {
  id: string;
  type: CanvasElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  props: Record<string, unknown>;
}

export async function createElements(tx: Tx, actor: Actor, projectId: string, elements: NewElement[]) {
  canvasGuard(actor, projectId);
  // Serialize creates per project so the element limit can't be overshot by concurrent requests.
  await tx`select pg_advisory_xact_lock(hashtext(${'canvas:' + projectId}))`;
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from canvas_elements where project_id = ${projectId} and deleted_at is null`;
  if (n + elements.length > LIMITS.canvasElementsPerProject) {
    throw new AppError('CANVAS_LIMIT_REACHED', `A canvas can hold at most ${LIMITS.canvasElementsPerProject} elements.`);
  }
  const result: ElementRow[] = [];
  let created = 0;
  for (const e of elements) {
    // Client-generated ids make creates idempotent: a retried create finds its own element.
    const [row] = await tx<ElementRow[]>`
      insert into canvas_elements (id, project_id, type, x, y, width, height, z_index, props, created_by, updated_by)
      values (${e.id}, ${projectId}, ${e.type}, ${e.x}, ${e.y}, ${e.width}, ${e.height}, ${e.zIndex},
              ${tx.json(e.props as any)}, ${actor.id}, ${actor.id})
      on conflict (id) do nothing
      returning ${ELEMENT_COLUMNS(tx)}`;
    if (row) {
      result.push(row);
      created++;
      continue;
    }
    const [existing] = await tx<ElementRow[]>`select ${ELEMENT_COLUMNS(tx)} from canvas_elements where id = ${e.id}`;
    if (!existing || existing.project_id !== projectId || existing.created_by !== actor.id) {
      throw new AppError('ELEMENT_CONFLICT', 'An element with this id already exists.', { conflicts: [{ id: e.id }] });
    }
    result.push(existing);
  }
  if (created > 0) await enqueueCanvasDigest(tx, actor, projectId, created);
  return { elements: await toElements(tx, result) };
}

export interface ElementChange {
  id: string;
  version: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  props?: Record<string, unknown>;
}

/** Per-element optimistic locking, all-or-nothing: one conflict rejects the whole batch. */
export async function patchElements(tx: Tx, actor: Actor, projectId: string, changes: ElementChange[]) {
  canvasGuard(actor, projectId);
  const updated: ElementRow[] = [];
  const conflicts: string[] = [];
  // Lock rows in a fixed (id) order: two batches touching the same elements in opposite order
  // would otherwise be able to deadlock.
  for (const c of [...changes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const [row] = await tx<ElementRow[]>`
      update canvas_elements set
        x = coalesce(${c.x ?? null}::float8, x),
        y = coalesce(${c.y ?? null}::float8, y),
        width = coalesce(${c.width ?? null}::float8, width),
        height = coalesce(${c.height ?? null}::float8, height),
        z_index = coalesce(${c.zIndex ?? null}::int, z_index),
        props = coalesce(${c.props ? tx.json(c.props as any) : null}::jsonb, props),
        version = version + 1, updated_by = ${actor.id}, updated_at = now()
      where id = ${c.id} and project_id = ${projectId} and version = ${c.version} and deleted_at is null
      returning ${ELEMENT_COLUMNS(tx)}`;
    if (row) updated.push(row);
    else conflicts.push(c.id);
  }
  if (conflicts.length > 0) throw await elementConflict(tx, projectId, conflicts);
  await enqueueCanvasDigest(tx, actor, projectId, updated.length);
  return { elements: await toElements(tx, updated) };
}

async function elementConflict(tx: Tx, projectId: string, ids: string[]) {
  const rows = await tx<ElementRow[]>`
    select ${ELEMENT_COLUMNS(tx)} from canvas_elements where id in ${tx(ids)} and project_id = ${projectId}`;
  const current = await toElements(tx, rows);
  const who = current.find((e) => e.updatedBy)?.updatedBy?.fullName ?? 'someone else';
  const deleted = current.some((e) => e.deleted);
  return new AppError(
    'ELEMENT_CONFLICT',
    deleted ? `${who} deleted something you were editing.` : `${who} changed this while you were editing it.`,
    {
      conflicts: ids.map((id) => ({ id, current: current.find((e) => e.id === id) ?? null })),
    },
  );
}

export async function deleteElements(tx: Tx, actor: Actor, projectId: string, elements: { id: string; version: number }[]) {
  canvasGuard(actor, projectId);
  const conflicts: string[] = [];
  for (const e of [...elements].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const [row] = await tx<{ type: CanvasElementType }[]>`
      select type from canvas_elements where id = ${e.id} and project_id = ${projectId}`;
    if (row && (row.type === 'stage_frame' || row.type === 'project_node')) {
      throw new AppError('VALIDATION_FAILED', 'Stages are removed through the workflow, and the project node cannot be removed.');
    }
    const done = await tx`
      update canvas_elements set deleted_at = now(), deleted_by = ${actor.id}, updated_by = ${actor.id},
        updated_at = now(), version = version + 1
      where id = ${e.id} and project_id = ${projectId} and version = ${e.version} and deleted_at is null
      returning id`;
    if (done.length === 0) conflicts.push(e.id);
  }
  if (conflicts.length > 0) throw await elementConflict(tx, projectId, conflicts);
  await enqueueCanvasDigest(tx, actor, projectId, elements.length);
}

export async function restoreElements(tx: Tx, actor: Actor, projectId: string, ids: string[]) {
  canvasGuard(actor, projectId);
  const rows = await tx<ElementRow[]>`
    update canvas_elements set deleted_at = null, deleted_by = null, updated_by = ${actor.id},
      updated_at = now(), version = version + 1
    where id in ${tx(ids)} and project_id = ${projectId} and deleted_at is not null
      and type not in ('stage_frame', 'project_node')
    returning ${ELEMENT_COLUMNS(tx)}`;
  if (rows.length > 0) await enqueueCanvasDigest(tx, actor, projectId, rows.length);
  return { elements: await toElements(tx, rows) };
}
