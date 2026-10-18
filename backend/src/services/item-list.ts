import { type Dashboard, type ItemListPage, type ItemView, LIMITS } from '@nops/shared';
import { sql, type Sql } from '../db';
import type { Actor } from '../domain/actor';
import { AppError } from '../domain/errors';
import { decodeCursor, encodeCursor } from './cursor';
import { hydrateSummaries, itemColumns, itemFrom, type ItemRow, memberJoin } from './item-queries';

export interface ListQuery {
  projectId?: string;
  view?: ItemView;
  stageId?: string[];
  type?: string[];
  priority?: number[];
  assigneeId?: string;
  due?: 'overdue' | 'today' | 'week';
  q?: string;
  sort: 'updated' | 'priority' | 'due';
  limit: number;
  cursor?: string;
}

type Fragment = ReturnType<Sql>;

const and = (db: Sql, parts: Fragment[]) => parts.reduce((acc, p) => db`${acc} and ${p}`);

const notDone = (db: Sql) => db`s.kind <> 'done'`;
// Uncorrelated subqueries: computed once per query (hashed), not once per item row.
const blockedExpr = (db: Sql) => db`i.id in (
  select l.blocked_item_id from item_links l join work_items b on b.id = l.blocker_item_id
  join workflow_stages bs on bs.id = b.stage_id
  where b.deleted_at is null and bs.kind <> 'done')`;
const awaitingExpr = (db: Sql) => db`i.stage_id in (
  select t.from_stage_id from workflow_transitions t join workflow_stages ts on ts.id = t.to_stage_id
  where t.deleted_at is null and ts.deleted_at is null and ts.requires_approval)`;

/** WHERE conditions for one dashboard view (docs/04-workflow-rules.md §4.6). Always member-scoped. */
export function viewCondition(db: Sql, actor: Actor, view: ItemView): Fragment {
  switch (view) {
    case 'assigned_to_me':
      return db`i.assignee_id = ${actor.id} and ${notDone(db)}`;
    case 'next_actions_due':
      return db`i.assignee_id = ${actor.id} and i.next_action is not null
                and i.next_action_due_at < date_trunc('day', now()) + interval '1 day'`;
    case 'overdue':
      return db`i.due_at < now() and ${notDone(db)}`;
    case 'awaiting_my_approval':
      return db`m.role in ('lead', 'manager') and ${awaitingExpr(db)}
                and i.created_by <> ${actor.id} and i.assignee_id is distinct from ${actor.id}`;
    case 'unassigned_urgent':
      return db`i.assignee_id is null and i.priority <= 2 and ${notDone(db)}`;
    case 'blocked':
      return db`${notDone(db)} and ${blockedExpr(db)}`;
    case 'forgotten':
      return db`${notDone(db)} and i.last_activity_at < now() - make_interval(days => ${LIMITS.forgottenDays})`;
  }
}

function filters(db: Sql, actor: Actor, q: ListQuery): Fragment[] {
  const parts: Fragment[] = [db`i.deleted_at is null`];
  if (q.projectId) parts.push(db`i.project_id = ${q.projectId}`);
  if (q.view) parts.push(viewCondition(db, actor, q.view));
  if (q.stageId?.length) parts.push(db`i.stage_id in ${db(q.stageId)}`);
  if (q.type?.length) parts.push(db`i.type::text in ${db(q.type)}`);
  if (q.priority?.length) parts.push(db`i.priority in ${db(q.priority)}`);
  if (q.assigneeId === 'me') parts.push(db`i.assignee_id = ${actor.id}`);
  else if (q.assigneeId === 'none') parts.push(db`i.assignee_id is null`);
  else if (q.assigneeId) parts.push(db`i.assignee_id = ${q.assigneeId}`);
  if (q.due === 'overdue') parts.push(db`i.due_at < now() and ${notDone(db)}`);
  if (q.due === 'today') parts.push(db`i.due_at < date_trunc('day', now()) + interval '1 day'`);
  if (q.due === 'week') parts.push(db`i.due_at < date_trunc('day', now()) + interval '7 days'`);
  if (q.q) {
    const key = /^([A-Za-z]{2,5})-(\d+)$/.exec(q.q.trim());
    parts.push(
      key
        ? db`(p.key = ${key[1].toUpperCase()} and i.number = ${Number(key[2])})`
        : db`i.search @@ websearch_to_tsquery('english', ${q.q})`,
    );
  }
  return parts;
}

const INFINITY = 'infinity';

function order(db: Sql, sort: ListQuery['sort']) {
  switch (sort) {
    case 'priority':
      return db`order by i.priority asc, coalesce(i.due_at, 'infinity'::timestamptz) asc, i.id asc`;
    case 'due':
      return db`order by coalesce(i.due_at, 'infinity'::timestamptz) asc, i.id asc`;
    default:
      return db`order by i.updated_at desc, i.id desc`;
  }
}

function cursorCondition(db: Sql, sort: ListQuery['sort'], raw: string | undefined): Fragment | null {
  const c = decodeCursor(raw) as any[] | null;
  if (!c) return null;
  if (!Array.isArray(c)) throw new AppError('VALIDATION_FAILED', 'Invalid cursor.');
  switch (sort) {
    // Due dates travel as text so the cursor can carry 'infinity' (items without a due date).
    case 'priority':
      return db`(i.priority, coalesce(i.due_at, 'infinity'::timestamptz), i.id) > (${c[0]}::int, ${String(c[1])}::text::timestamptz, ${c[2]}::uuid)`;
    case 'due':
      return db`(coalesce(i.due_at, 'infinity'::timestamptz), i.id) > (${String(c[0])}::text::timestamptz, ${c[1]}::uuid)`;
    default:
      return db`(i.updated_at, i.id) < (${c[0]}::timestamptz, ${c[1]}::uuid)`;
  }
}

function cursorFor(sort: ListQuery['sort'], r: ItemRow) {
  const due = r.due_at ? r.due_at.toISOString() : INFINITY;
  switch (sort) {
    case 'priority':
      return encodeCursor([r.priority, due, r.id]);
    case 'due':
      return encodeCursor([due, r.id]);
    default:
      return encodeCursor([r.updated_at.toISOString(), r.id]);
  }
}

/** Server-side filtered, searched, keyset-paginated list scoped to the caller's projects. */
export async function listItems(actor: Actor, q: ListQuery): Promise<ItemListPage> {
  const db = sql;
  const where = filters(db, actor, q);
  const cursorCond = cursorCondition(db, q.sort, q.cursor);
  const pageWhere = cursorCond ? [...where, cursorCond] : where;

  const [rows, [{ n }]] = await Promise.all([
    db<ItemRow[]>`
      select ${itemColumns(db)} ${itemFrom(db)} ${memberJoin(db, actor)}
      where ${and(db, pageWhere)}
      ${order(db, q.sort)}
      limit ${q.limit + 1}`,
    db<{ n: number }[]>`
      select count(*)::int as n from (
        select 1 ${itemFrom(db)} ${memberJoin(db, actor)}
        where ${and(db, where)}
        limit ${LIMITS.totalCountCap + 1}
      ) capped`,
  ]);
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  return {
    items: await hydrateSummaries(db, page),
    nextCursor: more ? cursorFor(q.sort, page[page.length - 1]) : null,
    total: Math.min(n, LIMITS.totalCountCap),
    totalIsCapped: n > LIMITS.totalCountCap,
  };
}

async function countView(actor: Actor, view: ItemView): Promise<number> {
  const db = sql;
  const [{ n }] = await db<{ n: number }[]>`
    select count(*)::int as n from (
      select 1 ${itemFrom(db)} ${memberJoin(db, actor)}
      where i.deleted_at is null and ${viewCondition(db, actor, view)}
      limit 1000
    ) capped`;
  return n;
}

export async function getDashboard(actor: Actor): Promise<Dashboard> {
  const views: [keyof Dashboard['counts'], ItemView][] = [
    ['assignedToMe', 'assigned_to_me'],
    ['nextActionsDue', 'next_actions_due'],
    ['overdue', 'overdue'],
    ['awaitingMyApproval', 'awaiting_my_approval'],
    ['unassignedUrgent', 'unassigned_urgent'],
    ['blocked', 'blocked'],
    ['forgotten', 'forgotten'],
  ];
  const counts = await Promise.all(views.map(([, v]) => countView(actor, v)));
  const db = sql;
  const dueRows = await db<ItemRow[]>`
    select ${itemColumns(db)} ${itemFrom(db)} ${memberJoin(db, actor)}
    where i.deleted_at is null and s.kind <> 'done' and i.due_at is not null
      and (i.assignee_id = ${actor.id} or (i.assignee_id is null and m.role in ('lead', 'manager')))
    order by i.due_at asc, i.id asc
    limit 10`;
  return {
    counts: Object.fromEntries(views.map(([k], i) => [k, counts[i]])) as Dashboard['counts'],
    dueSoon: await hydrateSummaries(db, dueRows),
  };
}
