import type { ProjectRole, UserMini, WorkerMini } from '@nops/shared';
import type { Sql } from '../db';

export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export interface UserRow {
  id: string;
  full_name: string;
  avatar_color: string;
  designation: string;
}

export function toUserMini(u: UserRow): UserMini {
  return { id: u.id, fullName: u.full_name, initials: initials(u.full_name), avatarColor: u.avatar_color };
}

/** Batch-load users by id. */
export async function loadUsers(db: Sql, ids: (string | null | undefined)[]): Promise<Map<string, UserRow>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await db<UserRow[]>`
    select id, full_name, avatar_color, designation from users where id in ${db(unique)}`;
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Worker nodes: user + their current role in the project + open items assigned to them there.
 * `pairs` are (projectId, userId).
 */
export async function loadWorkers(db: Sql, pairs: { projectId: string; userId: string }[]): Promise<Map<string, WorkerMini>> {
  const keyOf = (p: string, u: string) => `${p}:${u}`;
  const unique = new Map(pairs.map((p) => [keyOf(p.projectId, p.userId), p]));
  if (unique.size === 0) return new Map();
  const projectIds = [...new Set([...unique.values()].map((p) => p.projectId))];
  const userIds = [...new Set([...unique.values()].map((p) => p.userId))];
  const [users, roles, counts] = await Promise.all([
    loadUsers(db, userIds),
    db<{ project_id: string; user_id: string; role: ProjectRole }[]>`
      select project_id, user_id, role from project_members
      where valid_to is null and project_id in ${db(projectIds)} and user_id in ${db(userIds)}`,
    db<{ project_id: string; assignee_id: string; n: number }[]>`
      select i.project_id, i.assignee_id, count(*)::int as n
      from work_items i join workflow_stages s on s.id = i.stage_id
      where i.deleted_at is null and s.kind <> 'done'
        and i.project_id in ${db(projectIds)} and i.assignee_id in ${db(userIds)}
      group by 1, 2`,
  ]);
  const roleMap = new Map(roles.map((r) => [keyOf(r.project_id, r.user_id), r.role]));
  const countMap = new Map(counts.map((c) => [keyOf(c.project_id, c.assignee_id), c.n]));
  const result = new Map<string, WorkerMini>();
  for (const [k, p] of unique) {
    const u = users.get(p.userId);
    if (!u) continue;
    result.set(k, {
      ...toUserMini(u),
      designation: u.designation,
      projectRole: roleMap.get(k) ?? null,
      openItemCount: countMap.get(k) ?? 0,
    });
  }
  return result;
}
