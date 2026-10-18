import type { PersonProfile, ProjectRole, RoleHistoryRow } from '@nops/shared';
import { sql } from '../db';
import type { Actor } from '../domain/actor';
import { notFound } from '../domain/errors';
import { activityFilter, activityRows } from './items';
import { decodeCursor, encodeCursor } from './cursor';
import { initials } from './users';

/**
 * Projects whose information about `userId` the actor may see: projects the actor is a member of
 * (all projects for Admins and for yourself). Returns null when the actor may not see the person at all.
 */
async function visibleProjectIds(actor: Actor, userId: string): Promise<string[] | null> {
  if (actor.isAdmin || actor.id === userId) {
    const rows = await sql<{ id: string }[]>`select id from projects where org_id = ${actor.orgId}`;
    return rows.map((r) => r.id);
  }
  const mine = [...actor.roles.keys()];
  if (mine.length === 0) return null;
  const [shared] = await sql`
    select 1 from project_members
    where user_id = ${userId} and valid_to is null and project_id in ${sql(mine)} limit 1`;
  return shared ? mine : null;
}

async function guard(actor: Actor, userId: string) {
  const ids = await visibleProjectIds(actor, userId);
  if (!ids) throw notFound('Person');
  return ids;
}

export async function getPerson(actor: Actor, userId: string): Promise<PersonProfile> {
  const projectIds = await guard(actor, userId);
  const [u] = await sql<
    { id: string; full_name: string; avatar_color: string; email: string; designation: string; department: string; employee_code: string; created_at: Date }[]
  >`select id, full_name, avatar_color, email, designation, department, employee_code, created_at
    from users where id = ${userId} and org_id = ${actor.orgId}`;
  if (!u) throw notFound('Person');
  const [projects, [online]] = await Promise.all([
    sql<{ id: string; key: string; name: string; role: ProjectRole; valid_from: Date; open_items: number }[]>`
      select p.id, p.key, p.name, m.role, m.valid_from,
        (select count(*)::int from work_items i join workflow_stages s on s.id = i.stage_id
         where i.project_id = p.id and i.assignee_id = ${userId} and i.deleted_at is null and s.kind <> 'done') as open_items
      from project_members m join projects p on p.id = m.project_id
      where m.user_id = ${userId} and m.valid_to is null and p.id in ${sql(projectIds)}
      order by p.name`,
    sql`select 1 from presence where user_id = ${userId} and last_seen_at > now() - interval '60 seconds' limit 1`,
  ]);
  return {
    user: {
      id: u.id,
      fullName: u.full_name,
      initials: initials(u.full_name),
      avatarColor: u.avatar_color,
      email: u.email,
      designation: u.designation,
      department: u.department,
      employeeCode: u.employee_code,
      joinedAt: u.created_at.toISOString(),
    },
    online: Boolean(online),
    currentProjects: projects.map((p) => ({
      project: { id: p.id, key: p.key, name: p.name },
      role: p.role,
      since: p.valid_from.toISOString(),
      openItems: p.open_items,
    })),
  };
}

export async function getRoleHistory(actor: Actor, userId: string): Promise<RoleHistoryRow[]> {
  const projectIds = await guard(actor, userId);
  const rows = await sql<
    { id: string; key: string; name: string; role: ProjectRole; valid_from: Date; valid_to: Date | null; reason: string | null }[]
  >`
    select p.id, p.key, p.name, m.role, m.valid_from, m.valid_to, m.reason
    from project_members m join projects p on p.id = m.project_id
    where m.user_id = ${userId} and p.id in ${sql(projectIds)}
    order by m.valid_from desc`;
  return rows.map((r) => ({
    project: { id: r.id, key: r.key, name: r.name },
    role: r.role,
    validFrom: r.valid_from.toISOString(),
    validTo: r.valid_to?.toISOString() ?? null,
    reason: r.reason,
  }));
}

export async function getStats(actor: Actor, userId: string, q: { projectId?: string; period: 'month' | 'quarter' | 'all' }) {
  const projectIds = await guard(actor, userId);
  const scope = q.projectId ? projectIds.filter((p) => p === q.projectId) : projectIds;
  if (scope.length === 0) return { claimed: 0, resolved: 0, approved: 0, notes: 0 };
  if (q.period === 'all') {
    // Pre-computed by the worker, so profile pages never scan the full history.
    const [r] = await sql<{ claimed: number; resolved: number; approved: number; notes: number }[]>`
      select coalesce(sum(claimed), 0)::int as claimed, coalesce(sum(resolved), 0)::int as resolved,
             coalesce(sum(approved), 0)::int as approved, coalesce(sum(notes), 0)::int as notes
      from user_project_stats where user_id = ${userId} and project_id in ${sql(scope)}`;
    return r;
  }
  // Recent periods are a bounded index range scan on (actor_id, id).
  const days = q.period === 'month' ? 30 : 90;
  const [r] = await sql<{ claimed: number; resolved: number; approved: number; notes: number }[]>`
    select
      count(*) filter (where type = 'item.claimed')::int as claimed,
      count(*) filter (where type in ('item.transitioned', 'item.approved') and data->'to'->>'kind' = 'done')::int as resolved,
      count(*) filter (where type = 'item.approved')::int as approved,
      count(*) filter (where type = 'note.added')::int as notes
    from activity_events
    where actor_id = ${userId} and project_id in ${sql(scope)}
      and created_at > now() - make_interval(days => ${days})`;
  return r;
}

export async function getPersonActivity(actor: Actor, userId: string, q: { filter: string; limit: number; cursor?: string }) {
  const projectIds = await guard(actor, userId);
  const before = decodeCursor(q.cursor) as string | null;
  const items = await activityRows(
    sql,
    activityFilter(sql, { actorId: userId, projectIds, kind: q.filter, before: before ?? undefined }),
    q.limit + 1,
  );
  const more = items.length > q.limit;
  const page = items.slice(0, q.limit);
  return { items: page, nextCursor: more ? encodeCursor(page[page.length - 1].id) : null };
}
