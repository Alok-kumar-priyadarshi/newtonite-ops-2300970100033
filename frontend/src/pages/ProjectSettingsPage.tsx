import { PROJECT_ROLES } from '@nops/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useSafeMutation } from '../api/mutation';
import { useDirectory, useMembers, useProject } from '../api/queries';
import { Avatar, Button, ErrorState, inputCls, labelCls, ReasonDialog, Spinner } from '../components/ui';
import { ROLE_LABEL, shortDate } from '../lib/format';

const ROLE_BADGE: Record<string, string> = {
  manager: 'bg-violet-100 text-violet-800',
  lead: 'bg-blue-100 text-blue-800',
  member: 'bg-slate-100 text-slate-700',
};

type Pending =
  | { kind: 'role'; userId: string; name: string; role: string }
  | { kind: 'remove'; userId: string; name: string }
  | { kind: 'add'; userId: string; name: string; role: string }
  | null;

export function ProjectSettingsPage() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const members = useMembers(projectId);
  const directory = useDirectory();
  const [pending, setPending] = useState<Pending>(null);
  const [addUser, setAddUser] = useState('');
  const [addRole, setAddRole] = useState('member');
  const keys = () => [['members', projectId], ['projects'], ['me'], ['project', projectId]];

  const mutate = useSafeMutation({
    fn: async (v: { pending: NonNullable<Pending>; reason: string }, key) => {
      const p = v.pending;
      if (p.kind === 'role') return api('PATCH', `/projects/${projectId}/members/${p.userId}`, { role: p.role, reason: v.reason }, { idempotencyKey: key });
      if (p.kind === 'remove') return api('DELETE', `/projects/${projectId}/members/${p.userId}`, { reason: v.reason }, { idempotencyKey: key });
      return api('POST', `/projects/${projectId}/members`, { userId: p.userId, role: p.role, reason: v.reason }, { idempotencyKey: key });
    },
    invalidate: keys,
    successMessage: 'Members updated.',
    onSuccess: () => setAddUser(''),
  });

  if (project.isError) return <div className="p-6"><ErrorState error={project.error} /></div>;
  if (!project.data || !members.data) return <div className="p-6"><Spinner /></div>;
  const canManage = project.data.permissions.includes('project.manage_members');
  const memberIds = new Set(members.data.map((m) => m.user.id));

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <div className="flex gap-3 text-sm">
          <Link to="/projects" className="text-slate-500 hover:underline">← Projects</Link>
          {project.data.myRole && (
            <Link to={`/projects/${projectId}/canvas`} className="text-slate-500 hover:underline">Canvas</Link>
          )}
        </div>
        <h1 className="text-xl font-semibold">{project.data.name} · Team</h1>
        <p className="text-sm text-slate-500">
          {(['manager', 'lead', 'member'] as const)
            .map((r) => {
              const n = members.data.filter((m) => m.role === r).length;
              return n ? `${n} ${ROLE_LABEL[r]}${n > 1 ? 's' : ''}` : null;
            })
            .filter(Boolean)
            .join(' · ')}
          {' — '}
          {canManage
            ? 'Role changes are recorded with a reason and show up in each person’s work history.'
            : 'Only the Project Manager can change roles. Click a name to see their profile and work history.'}
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Person</th>
              <th className="px-4 py-2">Job title</th>
              <th className="px-4 py-2">Role in project</th>
              <th className="px-4 py-2 text-right">Open items</th>
              <th className="px-4 py-2">Since</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members.data.map((m) => (
              <tr key={m.user.id}>
                <td className="px-4 py-2">
                  <Link to={`/people/${m.user.id}`} className="flex items-center gap-2 font-medium hover:underline">
                    <Avatar user={m.user} /> {m.user.fullName}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-600">{m.user.designation || '—'}</td>
                <td className="px-4 py-2">
                  {canManage ? (
                    <select
                      className="rounded border border-slate-300 px-2 py-1"
                      value={m.role}
                      onChange={(e) => setPending({ kind: 'role', userId: m.user.id, name: m.user.fullName, role: e.target.value })}
                    >
                      {PROJECT_ROLES.map((r) => (
                        <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                      ))}
                    </select>
                  ) : (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE[m.role]}`}>{ROLE_LABEL[m.role]}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  <Link to={`/projects/${projectId}/list?assigneeId=${m.user.id}`} className="hover:underline">
                    {m.user.openItemCount}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-500">{shortDate(m.since)}</td>
                <td className="px-4 py-2 text-right">
                  {canManage && (
                    <Button variant="ghost" className="text-red-700" onClick={() => setPending({ kind: 'remove', userId: m.user.id, name: m.user.fullName })}>
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <form
          className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const u = directory.data?.find((d) => d.id === addUser);
            if (u) setPending({ kind: 'add', userId: u.id, name: u.fullName, role: addRole });
          }}
        >
          <label className={`${labelCls} flex-1`}>
            Add person
            <select className={`${inputCls} mt-1`} value={addUser} onChange={(e) => setAddUser(e.target.value)}>
              <option value="">Choose…</option>
              {directory.data?.filter((d) => !memberIds.has(d.id)).map((d) => (
                <option key={d.id} value={d.id}>{d.fullName} — {d.designation}</option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Role
            <select className={`${inputCls} mt-1`} value={addRole} onChange={(e) => setAddRole(e.target.value)}>
              {PROJECT_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={!addUser}>Add</Button>
        </form>
      )}

      {pending && (
        <ReasonDialog
          title={
            pending.kind === 'role'
              ? `Make ${pending.name} ${ROLE_LABEL[pending.role]}`
              : pending.kind === 'remove'
                ? `Remove ${pending.name} from the project`
                : `Add ${pending.name} as ${ROLE_LABEL[pending.role]}`
          }
          description={pending.kind !== 'remove' && pending.role === 'manager' ? 'The current Manager becomes a Lead.' : undefined}
          danger={pending.kind === 'remove'}
          busy={mutate.isPending}
          onClose={() => setPending(null)}
          onConfirm={(reason) => mutate.mutate({ pending, reason }, { onSettled: () => setPending(null) })}
        />
      )}
    </div>
  );
}
