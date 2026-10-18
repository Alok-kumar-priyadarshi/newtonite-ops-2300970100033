import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createItem, type Fixture, fixture, sql } from './helpers';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterAll(() => sql.end());

describe('A1 simultaneous actions', () => {
  it('10 parallel claims: exactly one wins, one claim event', async () => {
    const item = await createItem(f.users.lead, f.pay.id);
    const claimers = [f.users.member, f.users.member2, f.users.lead, f.users.manager];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => as(claimers[i % claimers.length]).post(`/api/items/${item.id}/claim`)),
    );
    const winners = results.filter((r) => r.status === 200 && r.body.assignee);
    // The winner may also see their own repeat as 200 ("already yours"), so count distinct assignees.
    const assignees = new Set(winners.map((r) => r.body.assignee.id));
    expect(assignees.size).toBe(1);
    const losers = results.filter((r) => r.status === 409);
    expect(losers.length).toBeGreaterThan(0);
    for (const l of losers) expect(l.body.error.code).toBe('ALREADY_CLAIMED');

    const [row] = await sql`select assignee_id from work_items where id = ${item.id}`;
    expect(assignees.has(row.assignee_id)).toBe(true);
    const [{ n }] = await sql`select count(*)::int as n from activity_events where item_id = ${item.id} and type = 'item.claimed'`;
    expect(n).toBe(1);
  });

  it('20 parallel creates get 20 distinct consecutive numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        as(f.users.member).post('/api/items', { projectId: f.pay.id, type: 'task', title: `Item ${i}`, priority: 3 }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.number).sort((a: number, b: number) => a - b);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('a move along a connection being deleted never succeeds after the delete', async () => {
    const item = await createItem(f.users.lead, f.pay.id);
    const [t] = await sql<{ id: string }[]>`
      select id from workflow_transitions where from_stage_id = ${f.pay.stages.open} and to_stage_id = ${f.pay.stages.progress}`;
    // Give the workflow another way out of Open so deleting this connection is allowed.
    await as(f.users.lead).post(`/api/projects/${f.pay.id}/workflow/transitions`, {
      id: crypto.randomUUID(),
      fromStageId: f.pay.stages.open,
      toStageId: f.pay.stages.awaiting,
    });
    const [move, del] = await Promise.all([
      as(f.users.lead).post(`/api/items/${item.id}/transition`, { version: 1, toStageId: f.pay.stages.progress }),
      as(f.users.lead).delete(`/api/projects/${f.pay.id}/workflow/transitions/${t.id}`),
    ]);
    expect(del.status).toBe(200);
    if (move.status === 200) {
      // The move committed first; the delete waited for it.
      const [ev] = await sql`select id from activity_events where item_id = ${item.id} and type = 'item.transitioned'`;
      const [d] = await sql`select id from activity_events where type = 'workflow.transition_removed'`;
      expect(Number(ev.id)).toBeLessThan(Number(d.id));
    } else {
      expect(move.body.error.code).toBe('INVALID_TRANSITION');
    }
  });

  it('two workflow edits that together would bypass approval: one is rejected', async () => {
    // Each edit alone is fine. Together: Open → Shortcut → Closed skips approval.
    const shortcut = crypto.randomUUID();
    await as(f.users.member).post(`/api/projects/${f.pay.id}/workflow/stages`, {
      id: shortcut,
      name: 'Shortcut',
      frame: { x: 0, y: 0, width: 300, height: 400 },
    });
    const [a, b] = await Promise.all([
      as(f.users.member).post(`/api/projects/${f.pay.id}/workflow/transitions`, {
        id: crypto.randomUUID(),
        fromStageId: f.pay.stages.open,
        toStageId: shortcut,
      }),
      as(f.users.member).post(`/api/projects/${f.pay.id}/workflow/transitions`, {
        id: crypto.randomUUID(),
        fromStageId: shortcut,
        toStageId: f.pay.stages.closed,
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 422]);
    const failed = a.status === 422 ? a : b;
    expect(failed.body.error.details.reason).toBe('APPROVAL_BYPASS');
  });
});
