import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { CSRF_HEADER, CSRF_VALUE } from '@nops/shared';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { sql } from '../src/db';
import { migrate } from '../src/migrate';
import { seedProjectStructure } from '../src/services/projects';

export const app = createApp();

const TABLES = [
  'presence',
  'idempotency_keys',
  'processed_stat_events',
  'user_project_stats',
  'notification_sources',
  'notifications',
  'outbox',
  'canvas_elements',
  'activity_events',
  'item_links',
  'work_items',
  'workflow_transitions',
  'workflow_stages',
  'workflows',
  'project_members',
  'projects',
  'teams',
  'users',
  'organizations',
];

let migrated = false;
export async function resetDb() {
  if (!migrated) {
    await migrate(false);
    migrated = true;
  }
  await sql.unsafe(`truncate ${TABLES.join(', ')} restart identity cascade`);
}

export interface Fixture {
  orgId: string;
  users: Record<'manager' | 'lead' | 'member' | 'member2' | 'outsider' | 'admin', string>;
  /** Approval workflow project: manager, lead, member, member2 */
  pay: { id: string; stages: Record<string, string> };
  /** Standard workflow project: outsider is the only member (besides manager) */
  other: { id: string; stages: Record<string, string> };
}

/** Two projects and six people with known roles. */
export async function fixture(): Promise<Fixture> {
  await resetDb();
  const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name) values ('Newtonite') returning id`;
  const [{ id: teamId }] = await sql<{ id: string }[]>`insert into teams (org_id, name) values (${orgId}, 'Finance') returning id`;
  const users = {} as Fixture['users'];
  for (const [i, key] of (['manager', 'lead', 'member', 'member2', 'outsider', 'admin'] as const).entries()) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into users (org_id, email, password_hash, full_name, employee_code, is_admin)
      values (${orgId}, ${key + '@test.local'}, 'x', ${key[0].toUpperCase() + key.slice(1) + ' User'}, ${'T' + i}, ${key === 'admin'})
      returning id`;
    users[key] = id;
  }
  const makeProject = async (key: string, template: 'approval' | 'standard', members: [string, string][]) => {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into projects (org_id, team_id, key, name, created_by) values (${orgId}, ${teamId}, ${key}, ${key + ' project'}, ${users.admin})
      returning id`;
    const stageIds = await sql.begin((tx) => seedProjectStructure(tx, id, users.admin, template));
    for (const [userId, role] of members) {
      await sql`insert into project_members (project_id, user_id, role) values (${id}, ${userId}, ${role})`;
    }
    return { id, stages: Object.fromEntries(stageIds) as Record<string, string> };
  };
  const pay = await makeProject('PAY', 'approval', [
    [users.manager, 'manager'],
    [users.lead, 'lead'],
    [users.member, 'member'],
    [users.member2, 'member'],
  ]);
  const other = await makeProject('OTH', 'standard', [
    [users.outsider, 'manager'],
  ]);
  return { orgId, users, pay, other };
}

/** HTTP client acting as a user: sets the session cookie, CSRF header and a fresh idempotency key. */
export function as(userId: string) {
  const cookie = `nops_session=${jwt.sign({ sub: userId }, config.SESSION_SECRET)}`;
  const withHeaders = (r: request.Test, key?: string | null) => {
    r.set('Cookie', cookie).set(CSRF_HEADER, CSRF_VALUE);
    if (key !== null) r.set('Idempotency-Key', key ?? randomUUID());
    return r;
  };
  return {
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    post: (url: string, body: unknown = {}, key?: string | null) => withHeaders(request(app).post(url), key).send(body as object),
    patch: (url: string, body: unknown = {}, key?: string | null) => withHeaders(request(app).patch(url), key).send(body as object),
    delete: (url: string, body: unknown = {}, key?: string | null) => withHeaders(request(app).delete(url), key).send(body as object),
  };
}

export async function createItem(userId: string, projectId: string, extra: Record<string, unknown> = {}) {
  const res = await as(userId).post('/api/items', {
    projectId,
    type: 'payment',
    title: 'ACME charged twice',
    description: 'Two debits on the statement',
    priority: 3,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`createItem failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; version: number; key: string; stage: { id: string } };
}

export { sql };
