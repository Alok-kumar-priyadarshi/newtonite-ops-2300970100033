import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { drainOutbox, processOutboxBatch } from '../src/outbox/process';
import { handlers } from '../src/outbox/handlers';
import { as, createItem, type Fixture, fixture, sql } from './helpers';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterAll(() => sql.end());

const notificationsFor = (userId: string) =>
  sql<{ type: string; title: string; source_event_id: string | null }[]>`
    select type, title, source_event_id from notifications where recipient_id = ${userId} order by id`;

describe('A6 reliable async processing', () => {
  it('a change writes exactly one outbox job in the same transaction', async () => {
    await createItem(f.users.member, f.pay.id);
    const jobs = await sql`select type from outbox`;
    expect(jobs.map((j) => j.type)).toEqual(['event']);
  });

  it('a rejected change writes no job and no history', async () => {
    const item = await createItem(f.users.member, f.pay.id);
    await sql`delete from outbox`;
    await as(f.users.member).delete(`/api/items/${item.id}`, { version: 1, reason: 'x' }); // 403
    expect(await sql`select 1 from outbox`).toHaveLength(0);
    const [{ n }] = await sql`select count(*)::int as n from activity_events where type = 'item.deleted'`;
    expect(n).toBe(0);
  });

  it('notifies every other current member, not the actor', async () => {
    await createItem(f.users.member, f.pay.id);
    await drainOutbox();
    for (const u of [f.users.manager, f.users.lead, f.users.member2]) {
      expect(await notificationsFor(u)).toHaveLength(1);
    }
    expect(await notificationsFor(f.users.member)).toHaveLength(0);
    expect(await notificationsFor(f.users.outsider)).toHaveLength(0);
  });

  it('processing the same job twice produces one notification per person', async () => {
    await createItem(f.users.member, f.pay.id);
    await drainOutbox();
    // Simulate a worker that died after doing the work but before marking it done.
    await sql`update outbox set status = 'processing', locked_until = now() - interval '1 second'`;
    expect(await processOutboxBatch()).toBe(1);
    expect(await notificationsFor(f.users.lead)).toHaveLength(1);
  });

  it('a member removed before the job runs is not notified', async () => {
    await createItem(f.users.member, f.pay.id);
    await sql`update project_members set valid_to = now() where user_id = ${f.users.member2}`;
    await drainOutbox();
    expect(await notificationsFor(f.users.member2)).toHaveLength(0);
  });

  it('failures retry with backoff, then are marked failed and can be retried by an admin', async () => {
    await createItem(f.users.member, f.pay.id);
    const failing = { ...handlers, event: async () => { throw new Error('mail server down'); } };
    await processOutboxBatch(10, failing);
    let [job] = await sql`select id, status, attempts, last_error, next_attempt_at > now() as later from outbox`;
    expect(job).toMatchObject({ status: 'pending', attempts: 1, last_error: 'mail server down', later: true });

    for (let i = 0; i < 4; i++) {
      // In the past, not now(): the column rounds to milliseconds and could land just after the
      // worker's own now(), making the job look "not due yet" (a flaky test, not an app bug).
      await sql`update outbox set next_attempt_at = now() - interval '1 second'`;
      await processOutboxBatch(10, failing);
    }
    [job] = await sql`select id, status, attempts from outbox`;
    expect(job).toMatchObject({ status: 'failed', attempts: 5 });

    const retry = await as(f.users.admin).post(`/api/admin/jobs/${job.id}/retry`);
    expect(retry.status).toBe(204);
    await drainOutbox();
    const [after] = await sql`select status from outbox`;
    expect(after.status).toBe('done');
    expect(await notificationsFor(f.users.lead)).toHaveLength(1);
  });

  it('two workers in parallel never process the same job', async () => {
    for (let i = 0; i < 10; i++) await createItem(f.users.member, f.pay.id);
    let calls = 0;
    const counting = { ...handlers, event: async (tx: any, p: any, j: any) => { calls++; await handlers.event(tx, p, j); } };
    const [a, b] = await Promise.all([processOutboxBatch(50, counting), processOutboxBatch(50, counting)]);
    expect(a + b).toBe(10);
    expect(calls).toBe(10);
  });

  it('canvas edits are grouped into one notification with an exact count, even with retries', async () => {
    const id = randomUUID();
    await as(f.users.member).post(`/api/projects/${f.pay.id}/canvas/elements`, {
      elements: [{ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, zIndex: 0, props: {} }],
    });
    for (let v = 1; v <= 11; v++) {
      await as(f.users.member).patch(`/api/projects/${f.pay.id}/canvas/elements`, { changes: [{ id, version: v, x: v }] });
    }
    await drainOutbox();
    await sql`update outbox set status = 'processing', locked_until = now() - interval '1 second' where type = 'canvas.changed'`;
    await drainOutbox(); // retry every job once more
    const list = await as(f.users.lead).get('/api/notifications');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].count).toBe(12);
  });

  it('profile stats count an event once even if processed twice', async () => {
    await createItem(f.users.member, f.pay.id).then((i) => as(f.users.member).post(`/api/items/${i.id}/claim`));
    await drainOutbox();
    await sql`update outbox set status = 'processing', locked_until = now() - interval '1 second'`;
    await drainOutbox();
    const [s] = await sql`select claimed from user_project_stats where user_id = ${f.users.member}`;
    expect(s.claimed).toBe(1);
  });
});

describe('housekeeping', () => {
  it('expires idempotency keys after 24 h and old finished jobs, but keeps recent ones', async () => {
    const { cleanupExpired } = await import('../src/outbox/maintenance');
    await createItem(f.users.member, f.pay.id); // one fresh key + one job
    await sql`insert into idempotency_keys (user_id, key, method, path, request_hash, created_at)
              values (${f.users.member}, 'old-key', 'POST', '/api/items', 'x', now() - interval '25 hours')`;
    await drainOutbox();
    await sql`update outbox set processed_at = now() - interval '8 days'`;
    const removed = await cleanupExpired();
    expect(removed).toMatchObject({ idempotencyKeys: 1, outboxJobs: 1 });
    const [{ n }] = await sql`select count(*)::int as n from idempotency_keys`;
    expect(n).toBe(1); // the fresh key stays, so a retry within 24 h is still safe
  });
});

describe('A7 history integrity', () => {
  it('records the actor role at the time, even after it changes', async () => {
    const item = await createItem(f.users.member, f.pay.id);
    await as(f.users.manager).patch(`/api/projects/${f.pay.id}/members/${f.users.member}`, { role: 'lead', reason: 'Promoted' });
    await as(f.users.member).patch(`/api/items/${item.id}`, { version: 1, priority: 1, reason: 'Urgent now' });
    const events = await sql`select type, actor_role from activity_events where item_id = ${item.id} order by id`;
    expect(events).toEqual([
      { type: 'item.created', actor_role: 'member' },
      { type: 'item.updated', actor_role: 'lead' },
    ]);
    const history = await as(f.users.member).get(`/api/people/${f.users.member}/history`);
    expect(history.body.map((h: any) => h.role)).toEqual(['lead', 'member']);
  });

  it('history cannot be edited, even directly in SQL', async () => {
    await createItem(f.users.member, f.pay.id);
    await expect(sql`update activity_events set type = 'tampered'`).rejects.toThrow(/append-only/);
    await expect(sql`delete from activity_events`).rejects.toThrow(/append-only/);
  });

  it('notes do not bump the item version (they never cause edit conflicts)', async () => {
    const item = await createItem(f.users.member, f.pay.id);
    const note = await as(f.users.member2).post(`/api/items/${item.id}/notes`, { kind: 'decision', body: 'Batch the reversals' });
    expect(note.status).toBe(201);
    const res = await as(f.users.lead).patch(`/api/items/${item.id}`, { version: 1, priority: 2, reason: 'x' });
    expect(res.status).toBe(200);
  });
});

describe('A8 pagination', () => {
  it('walks all pages without duplicates or gaps while new items are inserted', async () => {
    for (let i = 0; i < 25; i++) await createItem(f.users.member, f.pay.id, { title: `Item ${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    let inserted = false;
    do {
      const res: any = await as(f.users.member).get(`/api/items?projectId=${f.pay.id}&limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.items.map((i: any) => i.id));
      cursor = res.body.nextCursor;
      if (!inserted) {
        await createItem(f.users.member, f.pay.id, { title: 'Inserted mid-walk' });
        inserted = true;
      }
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(25);
  });

  it('combined filters (stage + priority + owner + text) match a direct SQL count', async () => {
    const mk = (title: string, priority: number, assigneeId?: string) =>
      createItem(f.users.lead, f.pay.id, { title, priority, assigneeId: assigneeId ?? null });
    await mk('Refund alpha', 1, f.users.member);
    await mk('Refund beta', 2, f.users.member);
    await mk('Refund gamma', 1, f.users.member2); // wrong owner
    await mk('Invoice delta', 1, f.users.member); // wrong text
    await mk('Refund epsilon', 3, f.users.member); // wrong priority
    const moved = await mk('Refund zeta', 1, f.users.member);
    await sql`update work_items set stage_id = ${f.pay.stages.progress} where id = ${moved.id}`; // wrong stage

    const url =
      `/api/items?projectId=${f.pay.id}&stageId=${f.pay.stages.open}&priority=1,2` +
      `&assigneeId=${f.users.member}&q=refund`;
    const res = await as(f.users.member).get(url);
    const [{ n }] = await sql`
      select count(*)::int as n from work_items
      where project_id = ${f.pay.id} and stage_id = ${f.pay.stages.open} and priority in (1, 2)
        and assignee_id = ${f.users.member} and title ilike '%refund%' and deleted_at is null`;
    expect(n).toBe(2);
    expect(res.body.total).toBe(n);
    expect(res.body.items.map((i: any) => i.title).sort()).toEqual(['Refund alpha', 'Refund beta']);
  });

  it('priority sort pages are ordered and complete', async () => {
    for (let i = 0; i < 12; i++) await createItem(f.users.member, f.pay.id, { priority: (i % 4) + 1 });
    const p1 = await as(f.users.member).get(`/api/items?projectId=${f.pay.id}&sort=priority&limit=5`);
    const p2 = await as(f.users.member).get(`/api/items?projectId=${f.pay.id}&sort=priority&limit=5&cursor=${p1.body.nextCursor}`);
    const p3 = await as(f.users.member).get(`/api/items?projectId=${f.pay.id}&sort=priority&limit=5&cursor=${p2.body.nextCursor}`);
    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((i: any) => i.priority);
    expect(all).toEqual([...all].sort());
    expect(all).toHaveLength(12);
    expect(p1.body.total).toBe(12);
  });
});
