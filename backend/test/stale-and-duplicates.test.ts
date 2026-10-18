import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createItem, type Fixture, fixture, sql } from './helpers';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterAll(() => sql.end());

describe('A2 stale data', () => {
  it('PATCH with an old version is rejected with the current item and what changed; row unchanged', async () => {
    const item = await createItem(f.users.manager, f.pay.id);
    const first = await as(f.users.lead).patch(`/api/items/${item.id}`, { version: 1, priority: 1, reason: 'Customer escalated' });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);

    const stale = await as(f.users.manager).patch(`/api/items/${item.id}`, { version: 1, priority: 4, reason: 'nope' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.current.version).toBe(2);
    expect(stale.body.error.details.changes).toEqual([
      expect.objectContaining({ field: 'priority', from: 3, to: 1, by: expect.objectContaining({ id: f.users.lead }) }),
    ]);
    const [row] = await sql`select priority, version from work_items where id = ${item.id}`;
    expect(row).toEqual({ priority: 1, version: 2 });
  });

  it('a stale transition changes nothing and writes no history', async () => {
    const item = await createItem(f.users.member, f.pay.id, { assigneeId: f.users.member });
    await as(f.users.lead).patch(`/api/items/${item.id}`, { version: 1, priority: 2, reason: 'x' });
    const res = await as(f.users.member).post(`/api/items/${item.id}/transition`, { version: 1, toStageId: f.pay.stages.progress });
    expect(res.status).toBe(409);
    const [row] = await sql`select stage_id from work_items where id = ${item.id}`;
    expect(row.stage_id).toBe(f.pay.stages.open);
    const [{ n }] = await sql`select count(*)::int as n from activity_events where item_id = ${item.id} and type like 'item.transition%'`;
    expect(n).toBe(0);
  });

  it('canvas batch with one stale element saves nothing (all-or-nothing)', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const base = { type: 'rectangle', x: 0, y: 0, width: 100, height: 50, zIndex: 0, props: {} };
    await as(f.users.member).post(`/api/projects/${f.pay.id}/canvas/elements`, { elements: [{ ...base, id: a }, { ...base, id: b }] });
    // Someone else moves b.
    await as(f.users.member2).patch(`/api/projects/${f.pay.id}/canvas/elements`, { changes: [{ id: b, version: 1, x: 500 }] });
    const res = await as(f.users.member).patch(`/api/projects/${f.pay.id}/canvas/elements`, {
      changes: [
        { id: a, version: 1, x: 10 },
        { id: b, version: 1, x: 10 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ELEMENT_CONFLICT');
    expect(res.body.error.details.conflicts[0]).toMatchObject({ id: b, current: { x: 500, version: 2 } });
    const [ra] = await sql`select x, version from canvas_elements where id = ${a}`;
    expect(ra).toEqual({ x: 0, version: 1 });
  });

  it('two batches moving the same elements in opposite order never deadlock', async () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const base = { type: 'rectangle', x: 0, y: 0, width: 10, height: 10, zIndex: 0, props: {} };
    await as(f.users.member).post(`/api/projects/${f.pay.id}/canvas/elements`, { elements: ids.map((id) => ({ ...base, id })) });
    const forward = ids.map((id) => ({ id, version: 1, x: 1 }));
    const backward = [...forward].reverse().map((c) => ({ ...c, x: 2 }));
    const [a, b] = await Promise.all([
      as(f.users.member).patch(`/api/projects/${f.pay.id}/canvas/elements`, { changes: forward }),
      as(f.users.member2).patch(`/api/projects/${f.pay.id}/canvas/elements`, { changes: backward }),
    ]);
    // One wins; the other gets a clean conflict (409), never a deadlock error (500/503).
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('acting on a deleted item returns 410 with who deleted it and why', async () => {
    const item = await createItem(f.users.member, f.pay.id);
    await as(f.users.manager).delete(`/api/items/${item.id}`, { version: 1, reason: 'Duplicate' });
    const res = await as(f.users.member).post(`/api/items/${item.id}/claim`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('ITEM_DELETED');
    expect(res.body.error.details.reason).toBe('Duplicate');
  });
});

describe('A3 duplicate operations', () => {
  const body = () => ({ projectId: f.pay.id, type: 'task', title: 'Same', priority: 3 });

  it('same key twice → one item, identical response, replay header', async () => {
    const key = randomUUID();
    const r1 = await as(f.users.member).post('/api/items', body(), key);
    const r2 = await as(f.users.member).post('/api/items', body(), key);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    const [{ n }] = await sql`select count(*)::int as n from work_items`;
    expect(n).toBe(1);
  });

  it('same key in parallel → one item', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => as(f.users.member).post('/api/items', body(), key)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const [{ n }] = await sql`select count(*)::int as n from work_items`;
    expect(n).toBe(1);
  });

  it('same key with a different body → 422', async () => {
    const key = randomUUID();
    await as(f.users.member).post('/api/items', body(), key);
    const res = await as(f.users.member).post('/api/items', { ...body(), title: 'Different' }, key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('missing key → 428', async () => {
    const res = await as(f.users.member).post('/api/items', body(), null);
    expect(res.status).toBe(428);
  });

  it('a rejected attempt is replayed for its key, and a new key can succeed', async () => {
    const item = await createItem(f.users.member, f.pay.id);
    const key = randomUUID();
    const bad = await as(f.users.member).post(`/api/items/${item.id}/transition`, { version: 1, toStageId: f.pay.stages.progress }, key);
    expect(bad.status).toBe(403); // not assigned to them
    const again = await as(f.users.member).post(`/api/items/${item.id}/transition`, { version: 1, toStageId: f.pay.stages.progress }, key);
    expect(again.status).toBe(403);
    expect(again.headers['idempotent-replayed']).toBe('true');
    await as(f.users.member).post(`/api/items/${item.id}/claim`);
    const good = await as(f.users.member).post(`/api/items/${item.id}/transition`, { version: 2, toStageId: f.pay.stages.progress });
    expect(good.status).toBe(200);
  });

  it('canvas create retried with the same element id → one element', async () => {
    const el = { id: randomUUID(), type: 'sticky', x: 1, y: 2, width: 100, height: 100, zIndex: 0, props: { text: 'hi' } };
    const r1 = await as(f.users.member).post(`/api/projects/${f.pay.id}/canvas/elements`, { elements: [el] });
    const r2 = await as(f.users.member).post(`/api/projects/${f.pay.id}/canvas/elements`, { elements: [el] });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const [{ n }] = await sql`select count(*)::int as n from canvas_elements where id = ${el.id}`;
    expect(n).toBe(1);
  });
});
