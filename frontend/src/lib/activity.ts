import type { ActivityEvent } from '@nops/shared';

/** Same wording as the server's describeEvent(), for timelines. */
export function describeActivity(e: Pick<ActivityEvent, 'type' | 'data'>): string {
  const d = e.data ?? {};
  switch (e.type) {
    case 'item.created':
      return 'created this item';
    case 'item.updated': {
      const changes = Object.entries(d.changes ?? {}) as [string, [unknown, unknown]][];
      return changes
        .map(([f, [from, to]]) => {
          if (f === 'priority') return `changed priority P${from} → P${to}`;
          if (f === 'nextAction') return to ? `set next action “${to}”` : 'cleared the next action';
          if (f === 'dueAt' || f === 'nextActionDueAt') return `changed ${f === 'dueAt' ? 'due date' : 'next action due'}`;
          return `changed ${f}`;
        })
        .join(', ');
    }
    case 'item.claimed':
      return 'claimed this item';
    case 'item.released':
      return 'released this item';
    case 'item.assigned':
      return d.toName ? `assigned it to ${d.toName}` : 'unassigned it';
    case 'item.transitioned':
      return `moved ${d.from?.name} → ${d.to?.name}`;
    case 'item.approved':
      return `✅ approved (${d.from?.name} → ${d.to?.name})`;
    case 'item.rejected':
      return `↩ rejected (${d.from?.name} → ${d.to?.name})`;
    case 'item.reopened':
      return `reopened (${d.from?.name} → ${d.to?.name})`;
    case 'item.deleted':
      return `deleted ${d.key ?? 'this item'}`;
    case 'item.restored':
      return 'restored this item';
    case 'item.link_added':
      return `marked it blocked by ${d.blockerKey}`;
    case 'item.link_removed':
      return `removed blocker ${d.blockerKey}`;
    default:
      return e.type;
  }
}
