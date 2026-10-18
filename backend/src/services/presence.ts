import { sql } from '../db';
import type { Actor } from '../domain/actor';
import { notFound } from '../domain/errors';
import { requireMember } from './projects';
import { loadUsers, toUserMini } from './users';

/** Records that the actor is looking at an item/canvas and returns who else is. */
export async function heartbeat(
  actor: Actor,
  input: { resourceType: 'item' | 'canvas'; resourceId: string; selectedElementIds: string[] },
) {
  let projectId: string;
  if (input.resourceType === 'canvas') {
    projectId = input.resourceId;
  } else {
    const [row] = await sql<{ project_id: string }[]>`select project_id from work_items where id = ${input.resourceId}`;
    if (!row) throw notFound('Item');
    projectId = row.project_id;
  }
  requireMember(actor, projectId);
  await sql`
    insert into presence (user_id, resource_type, resource_id, project_id, selected_element_ids, last_seen_at)
    values (${actor.id}, ${input.resourceType}, ${input.resourceId}, ${projectId}, ${sql.array(input.selectedElementIds, 2950)}, now())
    on conflict (user_id, resource_type, resource_id)
    do update set selected_element_ids = excluded.selected_element_ids, last_seen_at = now()`;
  const rows = await sql<{ user_id: string; selected_element_ids: string[]; last_seen_at: Date }[]>`
    select user_id, selected_element_ids, last_seen_at from presence
    where resource_type = ${input.resourceType} and resource_id = ${input.resourceId}
      and user_id <> ${actor.id} and last_seen_at > now() - interval '30 seconds'`;
  const users = await loadUsers(sql, rows.map((r) => r.user_id));
  return {
    viewers: rows
      .filter((r) => users.get(r.user_id))
      .map((r) => ({
        user: toUserMini(users.get(r.user_id)!),
        selectedElementIds: r.selected_element_ids,
        lastSeenAt: r.last_seen_at.toISOString(),
      })),
  };
}
