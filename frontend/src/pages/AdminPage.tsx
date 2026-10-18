import { WORKFLOW_TEMPLATES } from '@nops/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, get } from '../api/client';
import { useSafeMutation } from '../api/mutation';
import { useDirectory, useMe, useProjects, useTeams } from '../api/queries';
import { Button, EmptyState, inputCls, labelCls, Spinner } from '../components/ui';
import { HEALTH_META, timeAgo } from '../lib/format';

const TABS = ['Projects', 'Teams', 'Users', 'Failed jobs'] as const;

export function AdminPage() {
  const me = useMe().data!;
  const [tab, setTab] = useState<(typeof TABS)[number]>('Projects');
  if (!me.user.isAdmin) return <div className="p-6"><EmptyState title="Admins only" /></div>;
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">⚙ Admin</h1>
      <div className="flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button key={t} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-slate-600'}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Projects' && <ProjectsTab />}
      {tab === 'Teams' && <TeamsTab />}
      {tab === 'Users' && <UsersTab />}
      {tab === 'Failed jobs' && <JobsTab />}
    </div>
  );
}

function ProjectsTab() {
  const projects = useProjects();
  const teams = useTeams();
  const directory = useDirectory();
  const [form, setForm] = useState({ name: '', key: '', teamId: '', goal: '', template: 'standard', managerId: '' });
  const create = useSafeMutation({
    fn: (_: void, key) => api('POST', '/projects', form, { idempotencyKey: key }),
    invalidate: () => [['projects']],
    successMessage: 'Project created.',
    onSuccess: () => setForm({ name: '', key: '', teamId: '', goal: '', template: 'standard', managerId: '' }),
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="space-y-4">
      <table className="w-full overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
        <tbody className="divide-y divide-slate-100">
          {projects.data?.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-2 font-mono text-xs">{p.key}</td>
              <td className="px-4 py-2 font-medium">{p.name}</td>
              <td className="px-4 py-2">{p.team.name}</td>
              <td className="px-4 py-2"><span className={`rounded-full px-2 text-xs ${HEALTH_META[p.health].className}`}>{HEALTH_META[p.health].label}</span></td>
              <td className="px-4 py-2">{p.counts.open} open</td>
              <td className="px-4 py-2 text-right"><Link className="text-brand-700 hover:underline" to={`/projects/${p.id}/settings`}>Members</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className="font-semibold md:col-span-3">New project</h2>
        <label className={labelCls}>Name<input className={`${inputCls} mt-1`} value={form.name} onChange={set('name')} required /></label>
        <label className={labelCls}>Key (2–5 letters)<input className={`${inputCls} mt-1 uppercase`} value={form.key} onChange={set('key')} required maxLength={5} /></label>
        <label className={labelCls}>
          Team
          <select className={`${inputCls} mt-1`} value={form.teamId} onChange={set('teamId')} required>
            <option value="">Choose…</option>
            {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          Workflow template
          <select className={`${inputCls} mt-1`} value={form.template} onChange={set('template')}>
            {WORKFLOW_TEMPLATES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
          </select>
        </label>
        <label className={labelCls}>
          Project Manager
          <select className={`${inputCls} mt-1`} value={form.managerId} onChange={set('managerId')} required>
            <option value="">Choose…</option>
            {directory.data?.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
          </select>
        </label>
        <label className={labelCls}>Goal<input className={`${inputCls} mt-1`} value={form.goal} onChange={set('goal')} /></label>
        <div className="md:col-span-3"><Button type="submit" variant="primary" busy={create.isPending}>Create project</Button></div>
      </form>
    </div>
  );
}

function TeamsTab() {
  const teams = useTeams();
  const [name, setName] = useState('');
  const create = useSafeMutation({
    fn: (_: void, key) => api('POST', '/teams', { name }, { idempotencyKey: key }),
    invalidate: () => [['teams']],
    onSuccess: () => setName(''),
    successMessage: 'Team created.',
  });
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm">
        {teams.data?.map((t) => <li key={t.id} className="px-4 py-2">{t.name}</li>)}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" required />
        <Button type="submit" variant="primary" busy={create.isPending}>Add team</Button>
      </form>
    </div>
  );
}

function UsersTab() {
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => get<any[]>('/admin/users') });
  const [form, setForm] = useState({ email: '', fullName: '', designation: '', department: '', employeeCode: '', password: '', isAdmin: false });
  const create = useSafeMutation({
    fn: (_: void, key) => api('POST', '/admin/users', form, { idempotencyKey: key }),
    invalidate: () => [['admin-users'], ['directory']],
    successMessage: 'User created.',
  });
  const toggle = useSafeMutation({
    fn: (v: { id: string; active: boolean }) => api('POST', `/admin/users/${v.id}/active`, { active: v.active }),
    invalidate: () => [['admin-users'], ['directory']],
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="space-y-4">
      <table className="w-full rounded-xl border border-slate-200 bg-white text-sm">
        <tbody className="divide-y divide-slate-100">
          {users.data?.map((u) => (
            <tr key={u.id} className={u.isActive ? '' : 'text-slate-400'}>
              <td className="px-4 py-2 font-medium">{u.fullName}{u.isAdmin && ' (Admin)'}</td>
              <td className="px-4 py-2">{u.designation}</td>
              <td className="px-4 py-2">{u.email}</td>
              <td className="px-4 py-2 text-right">
                <Button variant="ghost" onClick={() => toggle.mutate({ id: u.id, active: !u.isActive })}>{u.isActive ? 'Deactivate' : 'Activate'}</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <h2 className="font-semibold md:col-span-3">New user</h2>
        <label className={labelCls}>Full name<input className={`${inputCls} mt-1`} value={form.fullName} onChange={set('fullName')} required /></label>
        <label className={labelCls}>Email<input className={`${inputCls} mt-1`} type="email" value={form.email} onChange={set('email')} required /></label>
        <label className={labelCls}>Employee code<input className={`${inputCls} mt-1`} value={form.employeeCode} onChange={set('employeeCode')} required /></label>
        <label className={labelCls}>Job title<input className={`${inputCls} mt-1`} value={form.designation} onChange={set('designation')} /></label>
        <label className={labelCls}>Department<input className={`${inputCls} mt-1`} value={form.department} onChange={set('department')} /></label>
        <label className={labelCls}>Initial password<input className={`${inputCls} mt-1`} type="password" minLength={8} value={form.password} onChange={set('password')} required /></label>
        <div className="md:col-span-3"><Button type="submit" variant="primary" busy={create.isPending}>Create user</Button></div>
      </form>
    </div>
  );
}

function JobsTab() {
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => get<{ items: any[] }>('/admin/jobs?status=failed'), refetchInterval: 15_000 });
  const retry = useSafeMutation({
    fn: (id: string) => api('POST', `/admin/jobs/${id}/retry`),
    invalidate: () => [['jobs']],
    successMessage: 'Queued for retry.',
  });
  if (jobs.isLoading) return <Spinner />;
  if (!jobs.data?.items.length) return <EmptyState title="No failed jobs">Background jobs that fail 5 times show up here.</EmptyState>;
  return (
    <table className="w-full rounded-xl border border-slate-200 bg-white text-sm">
      <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
        <tr><th className="px-4 py-2">Job</th><th className="px-4 py-2">Attempts</th><th className="px-4 py-2">Last error</th><th className="px-4 py-2">Created</th><th /></tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {jobs.data.items.map((j) => (
          <tr key={j.id}>
            <td className="px-4 py-2 font-mono text-xs">#{j.id} {j.type}</td>
            <td className="px-4 py-2">{j.attempts}</td>
            <td className="max-w-sm truncate px-4 py-2 text-red-700" title={j.lastError}>{j.lastError}</td>
            <td className="px-4 py-2 text-slate-500">{timeAgo(j.createdAt)}</td>
            <td className="px-4 py-2 text-right"><Button onClick={() => retry.mutate(j.id)}>Retry</Button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
