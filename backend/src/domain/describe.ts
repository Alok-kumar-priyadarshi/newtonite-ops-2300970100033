/** Human-readable one-liners for activity events, used on cards, timelines and notifications. */

const P = (n: unknown) => `P${n}`;

export function describeEvent(type: string, data: Record<string, any>): string {
  switch (type) {
    case 'item.created':
      return 'created this item';
    case 'item.updated': {
      const fields = Object.keys(data.changes ?? {});
      if (fields.length === 1 && fields[0] === 'priority') {
        const [from, to] = data.changes.priority;
        return `changed priority ${P(from)} → ${P(to)}`;
      }
      if (fields.length === 1 && fields[0] === 'nextAction') return 'updated the next action';
      return `updated ${fields.map(fieldLabel).join(', ')}`;
    }
    case 'item.claimed':
      return 'claimed this item';
    case 'item.released':
      return 'released this item';
    case 'item.assigned':
      return data.to ? `assigned it to ${data.toName ?? 'someone'}` : 'unassigned it';
    case 'item.transitioned':
      return `moved ${data.from?.name} → ${data.to?.name}`;
    case 'item.approved':
      return `approved (${data.from?.name} → ${data.to?.name})`;
    case 'item.rejected':
      return `rejected (${data.from?.name} → ${data.to?.name})`;
    case 'item.reopened':
      return `reopened (${data.from?.name} → ${data.to?.name})`;
    case 'item.deleted':
      return 'deleted this item';
    case 'item.restored':
      return 'restored this item';
    case 'item.link_added':
      return `marked it blocked by ${data.blockerKey}`;
    case 'item.link_removed':
      return `removed blocker ${data.blockerKey}`;
    case 'note.added':
      return `added a ${data.kind ?? 'note'}`;
    case 'project.created':
      return 'created the project';
    case 'project.updated':
      return `updated the project (${Object.keys(data.changes ?? {}).map(fieldLabel).join(', ')})`;
    case 'member.added':
      return `added ${data.userName} as ${data.role}`;
    case 'member.role_changed':
      return `changed ${data.userName}'s role ${data.from} → ${data.to}`;
    case 'member.removed':
      return `removed ${data.userName} from the project`;
    case 'workflow.stage_added':
      return `added stage "${data.name}"`;
    case 'workflow.stage_updated':
      return `updated stage "${data.name}"`;
    case 'workflow.stage_removed':
      return `removed stage "${data.name}"`;
    case 'workflow.transition_added':
      return `connected ${data.fromName} → ${data.toName}`;
    case 'workflow.transition_updated':
      return `updated connection ${data.fromName} → ${data.toName}`;
    case 'workflow.transition_removed':
      return `removed connection ${data.fromName} → ${data.toName}`;
    default:
      return type;
  }
}

export function fieldLabel(field: string): string {
  return (
    {
      title: 'title',
      description: 'description',
      type: 'type',
      dueAt: 'due date',
      priority: 'priority',
      nextAction: 'next action',
      nextActionDueAt: 'next action due',
      statusNote: 'status',
      health: 'health',
      name: 'name',
      goal: 'goal',
    } as Record<string, string>
  )[field] ?? field;
}

/** Notification title: "<actor> <summary> · <item key>" */
export function notificationTitle(actorName: string, type: string, data: Record<string, any>, itemKey: string | null) {
  const summary = describeEvent(type, data).replace('this item', itemKey ?? 'an item');
  const suffix = itemKey && !summary.includes(itemKey) ? ` · ${itemKey}` : '';
  const unblocks = data.unblocks?.length ? ` (unblocks ${data.unblocks.join(', ')})` : '';
  return `${actorName} ${summary}${suffix}${unblocks}`;
}
