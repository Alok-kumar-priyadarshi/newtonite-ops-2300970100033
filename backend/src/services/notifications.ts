import type { NotificationItem } from '@nops/shared';
import { sql } from '../db';
import type { Actor } from '../domain/actor';
import { decodeCursor, encodeCursor } from './cursor';
import { loadUsers, toUserMini } from './users';

interface Row {
  id: string;
  type: string;
  title: string;
  project_id: string;
  project_key: string;
  project_name: string;
  item_id: string | null;
  item_number: number | null;
  actor_id: string | null;
  digest_count: number | null;
  created_at: Date;
  read_at: Date | null;
}

export async function listNotifications(actor: Actor, q: { limit: number; cursor?: string; unreadOnly: boolean }) {
  const c = decodeCursor(q.cursor) as [string, string] | null;
  const rows = await sql<Row[]>`
    select n.id, n.type, n.title, n.project_id, p.key as project_key, p.name as project_name,
           n.item_id, w.number as item_number, n.actor_id, n.created_at, n.read_at,
           case when n.digest_key is not null
             then (select count(*)::int from notification_sources s where s.notification_id = n.id) end as digest_count
    from notifications n
    join projects p on p.id = n.project_id
    left join work_items w on w.id = n.item_id
    where n.recipient_id = ${actor.id}
      ${q.unreadOnly ? sql`and n.read_at is null` : sql``}
      ${c ? sql`and (n.created_at, n.id) < (${c[0]}::timestamptz, ${c[1]}::bigint)` : sql``}
    order by n.created_at desc, n.id desc
    limit ${q.limit + 1}`;
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const users = await loadUsers(sql, page.map((r) => r.actor_id));
  const items: NotificationItem[] = page.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.digest_count != null ? `${r.title} (${r.digest_count} change${r.digest_count === 1 ? '' : 's'})` : r.title,
    project: { id: r.project_id, key: r.project_key, name: r.project_name },
    item: r.item_id ? { id: r.item_id, key: `${r.project_key}-${r.item_number}` } : null,
    actor: r.actor_id && users.get(r.actor_id) ? toUserMini(users.get(r.actor_id)!) : null,
    count: r.digest_count,
    createdAt: r.created_at.toISOString(),
    readAt: r.read_at?.toISOString() ?? null,
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: more && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null };
}

export async function unreadCount(actor: Actor) {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from (
      select 1 from notifications where recipient_id = ${actor.id} and read_at is null limit 100
    ) capped`;
  return { count: n };
}

/** Idempotent: marking an already-read notification read changes nothing. */
export async function markRead(actor: Actor, id: string) {
  await sql`update notifications set read_at = coalesce(read_at, now()) where id = ${id} and recipient_id = ${actor.id}`;
}

export async function markAllRead(actor: Actor, before?: string) {
  await sql`
    update notifications set read_at = now()
    where recipient_id = ${actor.id} and read_at is null
      and created_at <= ${before ? new Date(before) : sql`now()`}`;
}
