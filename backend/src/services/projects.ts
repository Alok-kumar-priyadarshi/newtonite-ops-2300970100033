import { randomUUID } from 'node:crypto';
import type { ProjectDetail, ProjectHealth, ProjectRole, ProjectSummary, WorkflowTemplate } from '@nops/shared';
import { sql as rootSql, isUniqueViolation, type Sql, type Tx } from '../db';
import { type Actor, roleIn } from '../domain/actor';
import { AppError, notFound } from '../domain/errors';
import { authorize, permissionsFor, requireAdmin } from '../domain/permissions';
import { recordEvent } from './activity';
import { LAYOUT, TEMPLATES } from './templates';
import { loadUsers, loadWorkers, toUserMini } from './users';
import { loadWorkflow } from './workflow';

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  team_id: string;
  team_name: string;
  goal: string;
  status_note: string;
  health: ProjectHealth;
  version: number;
  updated_at: Date;
  updated_by: string | null;
}

/** Projects visible to the actor: their memberships, or all of them for an Admin (metadata only). */
async function projectRows(db: Sql, actor: Actor, projectId?: string): Promise<ProjectRow[]> {
  return db<ProjectRow[]>`
    select p.id, p.key, p.name, p.team_id, t.name as team_name, p.goal, p.status_note, p.health,
           p.version, p.updated_at, p.updated_by
    from projects p join teams t on t.id = p.team_id
    where p.org_id = ${actor.orgId}
      ${projectId ? db`and p.id = ${projectId}` : db``}
      ${
        actor.isAdmin
          ? db``
          : db`and exists (select 1 from project_members m where m.project_id = p.id and m.user_id = ${actor.id} and m.valid_to is null)`
      }
    order by t.name, p.name`;
}

async function summarize(db: Sql, actor: Actor, rows: ProjectRow[]): Promise<ProjectSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [counts, leaders] = await Promise.all([
    // The approval stages and the blocked items are each computed once (uncorrelated subqueries
    // become hashed lookups) instead of running two subqueries for every item row.
    db<{ project_id: string; open: number; overdue: number; awaiting: number; blocked: number }[]>`
      select i.project_id,
        count(*) filter (where s.kind <> 'done')::int as open,
        count(*) filter (where s.kind <> 'done' and i.due_at < now())::int as overdue,
        count(*) filter (where i.stage_id in (
          select t.from_stage_id from workflow_transitions t join workflow_stages ts on ts.id = t.to_stage_id
          where t.project_id in ${db(ids)} and t.deleted_at is null and ts.deleted_at is null and ts.requires_approval))::int as awaiting,
        count(*) filter (where s.kind <> 'done' and i.id in (
          select l.blocked_item_id from item_links l join work_items b on b.id = l.blocker_item_id
          join workflow_stages bs on bs.id = b.stage_id
          where l.project_id in ${db(ids)} and b.deleted_at is null and bs.kind <> 'done'))::int as blocked
      from work_items i join workflow_stages s on s.id = i.stage_id
      where i.project_id in ${db(ids)} and i.deleted_at is null
      group by i.project_id`,
    db<{ project_id: string; user_id: string; role: ProjectRole }[]>`
      select project_id, user_id, role from project_members
      where project_id in ${db(ids)} and valid_to is null and role in ('manager', 'lead')
      order by valid_from`,
  ]);
  const users = await loadUsers(db, [...leaders.map((l) => l.user_id), ...rows.map((r) => r.updated_by)]);
  const countMap = new Map(counts.map((c) => [c.project_id, c]));
  return rows.map((r) => {
    const c = countMap.get(r.id);
    const mgr = leaders.find((l) => l.project_id === r.id && l.role === 'manager');
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      team: { id: r.team_id, name: r.team_name },
      goal: r.goal,
      statusNote: r.status_note,
      health: r.health,
      myRole: roleIn(actor, r.id),
      manager: mgr && users.get(mgr.user_id) ? toUserMini(users.get(mgr.user_id)!) : null,
      leads: leaders
        .filter((l) => l.project_id === r.id && l.role === 'lead' && users.get(l.user_id))
        .map((l) => toUserMini(users.get(l.user_id)!)),
      counts: { open: c?.open ?? 0, awaitingApproval: c?.awaiting ?? 0, blocked: c?.blocked ?? 0, overdue: c?.overdue ?? 0 },
      version: r.version,
      updatedAt: r.updated_at.toISOString(),
      updatedBy: r.updated_by && users.get(r.updated_by) ? toUserMini(users.get(r.updated_by)!) : null,
    };
  });
}

export async function listProjects(actor: Actor): Promise<ProjectSummary[]> {
  return summarize(rootSql, actor, await projectRows(rootSql, actor));
}

export async function getProjectSummary(db: Sql, actor: Actor, projectId: string): Promise<ProjectSummary> {
  const rows = await projectRows(db, actor, projectId);
  if (rows.length === 0) throw notFound('Project');
  return (await summarize(db, actor, rows))[0];
}

export async function getProject(db: Sql, actor: Actor, projectId: string): Promise<ProjectDetail> {
  const summary = await getProjectSummary(db, actor, projectId);
  return {
    ...summary,
    permissions: permissionsFor(actor, { projectId }),
    workflow: await loadWorkflow(db, projectId),
  };
}

/** Members can see everything in a project; everyone else gets 404 (Admins: metadata routes only). */
export function requireMember(actor: Actor, projectId: string) {
  if (!roleIn(actor, projectId)) throw notFound('Project');
}

// ------------------------------------------------------------------ create

export interface CreateProjectInput {
  name: string;
  key: string;
  teamId: string;
  goal: string;
  template: WorkflowTemplate;
  managerId: string;
}

export async function createProject(tx: Tx, actor: Actor, input: CreateProjectInput) {
  requireAdmin(actor);
  const [team] = await tx`select id from teams where id = ${input.teamId} and org_id = ${actor.orgId}`;
  if (!team) throw new AppError('VALIDATION_FAILED', 'Team not found.');
  const [manager] = await tx`select id from users where id = ${input.managerId} and org_id = ${actor.orgId} and is_active`;
  if (!manager) throw new AppError('VALIDATION_FAILED', 'Manager not found.');

  let projectId: string;
  try {
    [{ id: projectId }] = await tx<{ id: string }[]>`
      insert into projects (org_id, team_id, key, name, goal, created_by, updated_by)
      values (${actor.orgId}, ${input.teamId}, ${input.key}, ${input.name}, ${input.goal}, ${actor.id}, ${actor.id})
      returning id`;
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('KEY_TAKEN', `The key ${input.key} is already used by another project.`);
    throw err;
  }
  await seedProjectStructure(tx, projectId, actor.id, input.template);
  await tx`
    insert into project_members (project_id, user_id, role, added_by, reason)
    values (${projectId}, ${input.managerId}, 'manager', ${actor.id}, 'Project created')`;
  await recordEvent(tx, { projectId, actor, type: 'project.created', data: { name: input.name, template: input.template } });
  return getProject(tx, actor, projectId);
}

/** Workflow + canvas frames + project node for a new project. Also used by the seed. */
export async function seedProjectStructure(tx: Tx, projectId: string, userId: string, template: WorkflowTemplate) {
  const tpl = TEMPLATES[template];
  await tx`insert into workflows (project_id, updated_by) values (${projectId}, ${userId})`;
  const stageIds = new Map<string, string>();
  for (const [index, s] of tpl.stages.entries()) {
    const id = randomUUID();
    stageIds.set(s.key, id);
    await tx`
      insert into workflow_stages (id, project_id, name, kind, requires_approval, sort_order)
      values (${id}, ${projectId}, ${s.name}, ${s.kind}, ${s.requiresApproval ?? false}, ${index})`;
    const f = LAYOUT.frame(index);
    await tx`
      insert into canvas_elements (id, project_id, type, stage_id, x, y, width, height, created_by, updated_by)
      values (${randomUUID()}, ${projectId}, 'stage_frame', ${id}, ${f.x}, ${f.y}, ${f.width}, ${f.height}, ${userId}, ${userId})`;
  }
  for (const t of tpl.transitions) {
    await tx`
      insert into workflow_transitions (project_id, from_stage_id, to_stage_id, label, requires_reason, lead_only, created_by)
      values (${projectId}, ${stageIds.get(t.from)!}, ${stageIds.get(t.to)!}, ${t.label ?? null},
              ${t.requiresReason ?? false}, ${t.leadOnly ?? false}, ${userId})`;
  }
  const p = LAYOUT.projectNode;
  await tx`
    insert into canvas_elements (id, project_id, type, x, y, width, height, created_by, updated_by)
    values (${randomUUID()}, ${projectId}, 'project_node', ${p.x}, ${p.y}, ${p.width}, ${p.height}, ${userId}, ${userId})`;
  return stageIds;
}

// ------------------------------------------------------------------ update

export interface PatchProjectInput {
  version: number;
  name?: string;
  goal?: string;
  statusNote?: string;
  health?: ProjectHealth;
}

export async function patchProject(tx: Tx, actor: Actor, projectId: string, input: PatchProjectInput) {
  const [row] = await tx<{ version: number; name: string; goal: string; status_note: string; health: ProjectHealth }[]>`
    select version, name, goal, status_note, health from projects
    where id = ${projectId} and org_id = ${actor.orgId} for update`;
  if (!row || (!roleIn(actor, projectId) && !actor.isAdmin)) throw notFound('Project');
  if (input.health !== undefined || input.statusNote !== undefined) authorize(actor, 'project.edit_status', { projectId });
  if (input.name !== undefined || input.goal !== undefined) authorize(actor, 'project.edit_details', { projectId });
  if (row.version !== input.version) {
    throw new AppError('VERSION_CONFLICT', 'The project was changed by someone else.', {
      current: await getProjectSummary(tx, actor, projectId),
      changes: [],
    });
  }
  const before: Record<string, unknown> = { name: row.name, goal: row.goal, statusNote: row.status_note, health: row.health };
  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of ['name', 'goal', 'statusNote', 'health'] as const) {
    if (input[k] !== undefined && input[k] !== before[k]) changes[k] = [before[k], input[k]];
  }
  if (Object.keys(changes).length > 0) {
    await tx`
      update projects set
        name = ${input.name ?? row.name}, goal = ${input.goal ?? row.goal},
        status_note = ${input.statusNote ?? row.status_note}, health = ${input.health ?? row.health},
        version = version + 1, updated_at = now(), updated_by = ${actor.id}
      where id = ${projectId}`;
    await recordEvent(tx, { projectId, actor, type: 'project.updated', data: { changes } });
  }
  return getProjectSummary(tx, actor, projectId);
}

// ------------------------------------------------------------------ members

export async function listMembers(actor: Actor, projectId: string) {
  if (!roleIn(actor, projectId) && !actor.isAdmin) throw notFound('Project');
  const rows = await rootSql<{ user_id: string; role: ProjectRole; valid_from: Date }[]>`
    select user_id, role, valid_from from project_members
    where project_id = ${projectId} and valid_to is null
    order by case role when 'manager' then 0 when 'lead' then 1 else 2 end, valid_from`;
  const workers = await loadWorkers(rootSql, rows.map((r) => ({ projectId, userId: r.user_id })));
  return rows
    .filter((r) => workers.get(`${projectId}:${r.user_id}`))
    .map((r) => ({ user: workers.get(`${projectId}:${r.user_id}`)!, role: r.role, since: r.valid_from.toISOString() }));
}

async function lockProject(tx: Tx, actor: Actor, projectId: string) {
  const [p] = await tx`select id from projects where id = ${projectId} and org_id = ${actor.orgId} for update`;
  if (!p || (!roleIn(actor, projectId) && !actor.isAdmin)) throw notFound('Project');
  authorize(actor, 'project.manage_members', { projectId });
}

async function currentMembership(tx: Tx, projectId: string, userId: string) {
  const [m] = await tx<{ id: string; role: ProjectRole }[]>`
    select id, role from project_members where project_id = ${projectId} and user_id = ${userId} and valid_to is null`;
  return m ?? null;
}

async function closeMembership(tx: Tx, id: string) {
  await tx`update project_members set valid_to = now() where id = ${id}`;
}

async function openMembership(tx: Tx, actor: Actor, projectId: string, userId: string, role: ProjectRole, reason: string) {
  await tx`
    insert into project_members (project_id, user_id, role, added_by, reason)
    values (${projectId}, ${userId}, ${role}, ${actor.id}, ${reason})`;
}

/** Making someone Manager hands over the role: the current Manager becomes a Lead. */
async function handOverManager(tx: Tx, actor: Actor, projectId: string, newManagerId: string, reason: string) {
  const [current] = await tx<{ id: string; user_id: string }[]>`
    select id, user_id from project_members where project_id = ${projectId} and role = 'manager' and valid_to is null`;
  if (current && current.user_id !== newManagerId) {
    await closeMembership(tx, current.id);
    await openMembership(tx, actor, projectId, current.user_id, 'lead', `Handed over management: ${reason}`);
  }
}

export async function addMember(tx: Tx, actor: Actor, projectId: string, input: { userId: string; role: ProjectRole; reason: string }) {
  await lockProject(tx, actor, projectId);
  const [user] = await tx<{ full_name: string }[]>`
    select full_name from users where id = ${input.userId} and org_id = ${actor.orgId} and is_active`;
  if (!user) throw new AppError('VALIDATION_FAILED', 'User not found.');
  if (await currentMembership(tx, projectId, input.userId)) {
    throw new AppError('ALREADY_MEMBER', `${user.full_name} is already a member of this project.`);
  }
  if (input.role === 'manager') await handOverManager(tx, actor, projectId, input.userId, input.reason);
  await openMembership(tx, actor, projectId, input.userId, input.role, input.reason);
  await recordEvent(tx, {
    projectId,
    actor,
    type: 'member.added',
    data: { userId: input.userId, userName: user.full_name, role: input.role, reason: input.reason },
  });
  return listMembersTx(tx, projectId);
}

export async function changeRole(tx: Tx, actor: Actor, projectId: string, userId: string, input: { role: ProjectRole; reason: string }) {
  await lockProject(tx, actor, projectId);
  const m = await currentMembership(tx, projectId, userId);
  if (!m) throw notFound('Member');
  if (m.role === input.role) return listMembersTx(tx, projectId);
  if (m.role === 'manager') {
    throw new AppError('LAST_MANAGER', 'A project always needs a Manager. Make someone else Manager first.');
  }
  const users = await loadUsers(tx, [userId]);
  if (input.role === 'manager') await handOverManager(tx, actor, projectId, userId, input.reason);
  await closeMembership(tx, m.id);
  await openMembership(tx, actor, projectId, userId, input.role, input.reason);
  await recordEvent(tx, {
    projectId,
    actor,
    type: 'member.role_changed',
    data: { userId, userName: users.get(userId)?.full_name, from: m.role, to: input.role, reason: input.reason },
  });
  return listMembersTx(tx, projectId);
}

export async function removeMember(tx: Tx, actor: Actor, projectId: string, userId: string, input: { reason: string }) {
  await lockProject(tx, actor, projectId);
  const m = await currentMembership(tx, projectId, userId);
  if (!m) throw notFound('Member');
  if (m.role === 'manager') {
    throw new AppError('LAST_MANAGER', 'A project always needs a Manager. Make someone else Manager first.');
  }
  const users = await loadUsers(tx, [userId]);
  await tx`update project_members set valid_to = now(), reason = ${input.reason} where id = ${m.id}`;
  await recordEvent(tx, {
    projectId,
    actor,
    type: 'member.removed',
    data: { userId, userName: users.get(userId)?.full_name, role: m.role, reason: input.reason },
  });
}

async function listMembersTx(tx: Tx, projectId: string) {
  const rows = await tx<{ user_id: string; role: ProjectRole; valid_from: Date }[]>`
    select user_id, role, valid_from from project_members where project_id = ${projectId} and valid_to is null`;
  const workers = await loadWorkers(tx, rows.map((r) => ({ projectId, userId: r.user_id })));
  return rows.map((r) => ({ user: workers.get(`${projectId}:${r.user_id}`)!, role: r.role, since: r.valid_from.toISOString() }));
}
