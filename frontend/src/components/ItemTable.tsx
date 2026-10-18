import type { ItemSummary } from '@nops/shared';
import { timeAgo } from '../lib/format';
import { Avatar, PriorityChip, StageChip, TypeIcon } from './ui';

export function ItemTable({ items, onOpen, selectedId }: { items: ItemSummary[]; onOpen: (id: string) => void; selectedId?: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-2 py-2 font-medium">Type</th>
            <th className="px-2 py-2 font-medium">P</th>
            <th className="px-2 py-2 font-medium">Title</th>
            <th className="px-2 py-2 font-medium">Stage</th>
            <th className="px-2 py-2 font-medium">Owner</th>
            <th className="px-2 py-2 font-medium">Next action</th>
            <th className="px-3 py-2 text-right font-medium">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((i) => (
            <tr
              key={i.id}
              tabIndex={0}
              onClick={() => onOpen(i.id)}
              onKeyDown={(e) => e.key === 'Enter' && onOpen(i.id)}
              className={`cursor-pointer hover:bg-slate-50 ${selectedId === i.id ? 'bg-brand-50' : ''}`}
            >
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">{i.key}</td>
              <td className="px-2 py-2"><TypeIcon type={i.type} /></td>
              <td className="px-2 py-2"><PriorityChip priority={i.priority} /></td>
              <td className="max-w-[380px] px-2 py-2">
                <div className="truncate font-medium text-slate-900">{i.title}</div>
                <div className="flex gap-2 text-xs">
                  {i.isOverdue && <span className="text-red-700">⏰ overdue</span>}
                  {i.isBlocked && <span className="text-red-700">⛓ blocked</span>}
                  {i.awaitingApproval && <span className="text-amber-700">✋ needs approval</span>}
                </div>
              </td>
              <td className="whitespace-nowrap px-2 py-2"><StageChip name={i.stage.name} kind={i.stage.kind} /></td>
              <td className="px-2 py-2"><Avatar user={i.assignee} /></td>
              <td className="max-w-[200px] truncate px-2 py-2 text-slate-600">{i.nextAction ?? '—'}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500">{timeAgo(i.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
