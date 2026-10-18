import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createItem, type Fixture, fixture, sql } from './helpers';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterAll(() => sql.end());

async function moveTo(userId: string, itemId: string, stage: string, reason?: string) {
  const [{ version }] = await sql`select version from work_items where id = ${itemId}`;
  return as(userId).post(`/api/items/${itemId}/transition`, { version, toStageId: stage, reason });
}

describe('A4 workflow rules', () => {
  it('Open → Closed (no connection) is rejected', async () => {
    const item = await createItem(f.users.lead, f.pay.id);
    const res = await moveTo(f.users.lead, item.id, f.pay.stages.closed);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('member cannot move an item that is not theirs', async () => {
    const item = await createItem(f.users.lead, f.pay.id);
    const res = await moveTo(f.users.member, item.id, f.pay.stages.progress);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ASSIGNEE');
  });

  it('approval: member rejected, creator/assignee rejected, other lead accepted', async () => {
    const item = await createItem(f.users.member, f.pay.id, { assigneeId: f.users.member });
    expect((await moveTo(f.users.member, item.id, f.pay.stages.progress)).status).toBe(200);
    expect((await moveTo(f.users.member, item.id, f.pay.stages.awaiting)).status).toBe(200);

    const byMember = await moveTo(f.users.member, item.id, f.pay.stages.approved);
    expect(byMember.body.error.code).toBe('APPROVAL_ROLE_REQUIRED');

    // Lead becomes assignee → can't approve own work.
    await sql`update work_items set assignee_id = ${f.users.lead} where id = ${item.id}`;
    const byAssignee = await moveTo(f.users.lead, item.id, f.pay.stages.approved);
    expect(byAssignee.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');

    const byManager = await moveTo(f.users.manager, item.id, f.pay.stages.approved);
    expect(byManager.status).toBe(200);
    const [ev] = await sql`select type, actor_role from activity_events where item_id = ${item.id} order by id desc limit 1`;
    expect(ev).toEqual({ type: 'item.approved', actor_role: 'manager' });
  });

  it('reject needs a reason', async () => {
    const item = await createItem(f.users.member, f.pay.id, { assigneeId: f.users.member });
    await moveTo(f.users.member, item.id, f.pay.stages.progress);
    await moveTo(f.users.member, item.id, f.pay.stages.awaiting);
    const res = await moveTo(f.users.lead, item.id, f.pay.stages.progress);
    expect(res.body.error.code).toBe('REASON_REQUIRED');
    expect((await moveTo(f.users.lead, item.id, f.pay.stages.progress, 'Missing invoice')).status).toBe(200);
  });

  it('blocked items cannot finish until the blocker is done', async () => {
    const blocker = await createItem(f.users.lead, f.pay.id, { assigneeId: f.users.lead });
    const item = await createItem(f.users.member, f.pay.id, { assigneeId: f.users.member });
    expect((await as(f.users.member).post(`/api/items/${item.id}/links`, { blockerItemId: blocker.id })).status).toBe(201);
    await moveTo(f.users.member, item.id, f.pay.stages.progress);
    await moveTo(f.users.member, item.id, f.pay.stages.awaiting);
    const blocked = await moveTo(f.users.manager, item.id, f.pay.stages.approved);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BLOCKED_BY_OPEN_ITEMS');

    await moveTo(f.users.lead, blocker.id, f.pay.stages.progress);
    await moveTo(f.users.lead, blocker.id, f.pay.stages.awaiting);
    expect((await moveTo(f.users.manager, blocker.id, f.pay.stages.approved)).status).toBe(200);
    expect((await moveTo(f.users.manager, item.id, f.pay.stages.approved)).status).toBe(200);
  });

  it('dependency cycles are rejected', async () => {
    const a = await createItem(f.users.member, f.pay.id);
    const b = await createItem(f.users.member, f.pay.id);
    expect((await as(f.users.member).post(`/api/items/${b.id}/links`, { blockerItemId: a.id })).status).toBe(201);
    const res = await as(f.users.member).post(`/api/items/${a.id}/links`, { blockerItemId: b.id });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEPENDENCY_CYCLE');
  });

  it('a member cannot add a shortcut that skips approval', async () => {
    const res = await as(f.users.member).post(`/api/projects/${f.pay.id}/workflow/transitions`, {
      id: randomUUID(),
      fromStageId: f.pay.stages.progress,
      toStageId: f.pay.stages.closed,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('APPROVAL_BYPASS');
  });

  it('a member can insert a new step between two steps', async () => {
    const [t] = await sql<{ id: string }[]>`
      select id from workflow_transitions where from_stage_id = ${f.pay.stages.progress} and to_stage_id = ${f.pay.stages.awaiting}`;
    const res = await as(f.users.member).post(`/api/projects/${f.pay.id}/workflow/stages`, {
      id: randomUUID(),
      name: 'Bank verification',
      frame: { x: 0, y: 0, width: 300, height: 400 },
      insertOnTransitionId: t.id,
    });
    expect(res.status).toBe(201);
    const names = res.body.transitions.map((x: any) => {
      const n = (id: string) => res.body.stages.find((s: any) => s.id === id).name;
      return `${n(x.fromStageId)} → ${n(x.toStageId)}`;
    });
    expect(names).toContain('In Progress → Bank verification');
    expect(names).toContain('Bank verification → Awaiting Approval');
    expect(names).not.toContain('In Progress → Awaiting Approval');
  });

  it('only leads change approval rules; non-empty stages cannot be deleted', async () => {
    const protect = await as(f.users.member).patch(`/api/projects/${f.pay.id}/workflow/stages/${f.pay.stages.closed}`, {
      version: 1,
      requiresApproval: true,
    });
    expect(protect.body.error.code).toBe('LEAD_OR_MANAGER_REQUIRED');
    await createItem(f.users.member, f.pay.id);
    const del = await as(f.users.lead).delete(`/api/projects/${f.pay.id}/workflow/stages/${f.pay.stages.open}`);
    expect(del.status).toBe(422); // start stage
    const item = await createItem(f.users.member, f.pay.id, { assigneeId: f.users.member });
    await moveTo(f.users.member, item.id, f.pay.stages.progress);
    const delProgress = await as(f.users.member).delete(`/api/projects/${f.pay.id}/workflow/stages/${f.pay.stages.progress}`);
    expect(delProgress.status).toBe(409);
    expect(delProgress.body.error.code).toBe('STAGE_NOT_EMPTY');
  });
});

describe('A5 resource-level authorization', () => {
  it('non-members get 404 on read, write, canvas, and never see items in lists or search', async () => {
    const item = await createItem(f.users.member, f.pay.id, { title: 'Zebracorn vendor refund' });
    const o = as(f.users.outsider);
    expect((await o.get(`/api/items/${item.id}`)).status).toBe(404);
    expect((await o.patch(`/api/items/${item.id}`, { version: 1, priority: 1, reason: 'x' })).status).toBe(404);
    expect((await o.post(`/api/items/${item.id}/claim`)).status).toBe(404);
    expect((await o.get(`/api/projects/${f.pay.id}/canvas`)).status).toBe(404);
    expect((await o.get(`/api/projects/${f.pay.id}`)).status).toBe(404);
    const search = await o.get('/api/items?q=Zebracorn');
    expect(search.status).toBe(200);
    expect(search.body.items).toEqual([]);
    const mine = await as(f.users.member).get('/api/items?q=Zebracorn');
    expect(mine.body.items.map((i: any) => i.id)).toEqual([item.id]);
  });

  it('members get specific 403s for manager/lead actions', async () => {
    const item = await createItem(f.users.member, f.pay.id);
    const m = as(f.users.member);
    const del = await m.delete(`/api/items/${item.id}`, { version: 1, reason: 'x' });
    expect([del.status, del.body.error.code]).toEqual([403, 'NOT_PROJECT_MANAGER']);
    expect(del.body.error.message).toBe('Only the Project Manager can delete items.');
    const assign = await m.post(`/api/items/${item.id}/assign`, { version: 1, assigneeId: f.users.member2, reason: 'x' });
    expect(assign.body.error.code).toBe('LEAD_OR_MANAGER_REQUIRED');
    const title = await as(f.users.lead).patch(`/api/items/${item.id}`, { version: 1, title: 'New' });
    expect(title.body.error.code).toBe('NOT_PROJECT_MANAGER');
    const priority = await m.patch(`/api/items/${item.id}`, { version: 1, priority: 1, reason: 'urgent' });
    expect([priority.status, priority.body.error.code]).toEqual([403, 'LEAD_OR_MANAGER_REQUIRED']);
    const [row] = await sql`select deleted_at, title from work_items where id = ${item.id}`;
    expect(row.deleted_at).toBeNull();
  });

  it('a removed member is locked out on their very next request', async () => {
    const item = await createItem(f.users.member, f.pay.id);
    expect((await as(f.users.member2).get(`/api/items/${item.id}`)).status).toBe(200);
    const rm = await as(f.users.manager).delete(`/api/projects/${f.pay.id}/members/${f.users.member2}`, { reason: 'Moved teams' });
    expect(rm.status).toBe(204);
    expect((await as(f.users.member2).get(`/api/items/${item.id}`)).status).toBe(404);
  });

  it('inactive users get 401; writes without the CSRF header get 403', async () => {
    await sql`update users set is_active = false where id = ${f.users.member2}`;
    expect((await as(f.users.member2).get('/api/me')).status).toBe(401);
    const { default: request } = await import('supertest');
    const { app } = await import('./helpers');
    const res = await request(app).post('/api/items').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_HEADER_MISSING');
  });

  it('admins see project metadata but not items', async () => {
    const item = await createItem(f.users.member, f.pay.id);
    const a = as(f.users.admin);
    const list = await a.get('/api/projects');
    expect(list.body.map((p: any) => p.key).sort()).toEqual(['OTH', 'PAY']);
    expect((await a.get(`/api/items/${item.id}`)).status).toBe(404);
    expect((await a.get(`/api/projects/${f.pay.id}/canvas`)).status).toBe(404);
  });

  it('every member sees the whole team with roles; only the Manager changes roles', async () => {
    for (const u of [f.users.member, f.users.lead]) {
      const res = await as(u).get(`/api/projects/${f.pay.id}/members`);
      expect(res.status).toBe(200);
      expect(res.body.map((m: any) => m.role).sort()).toEqual(['lead', 'manager', 'member', 'member']);
      expect(res.body[0].user).toEqual(expect.objectContaining({ fullName: expect.any(String), openItemCount: expect.any(Number) }));
    }
    expect((await as(f.users.outsider).get(`/api/projects/${f.pay.id}/members`)).status).toBe(404);
    const change = await as(f.users.lead).patch(`/api/projects/${f.pay.id}/members/${f.users.member}`, { role: 'lead', reason: 'x' });
    expect([change.status, change.body.error.code]).toEqual([403, 'NOT_PROJECT_MANAGER']);
  });

  it('profiles are visible only to people who share a project', async () => {
    expect((await as(f.users.member).get(`/api/people/${f.users.lead}`)).status).toBe(200);
    expect((await as(f.users.outsider).get(`/api/people/${f.users.lead}`)).status).toBe(404);
  });
});
