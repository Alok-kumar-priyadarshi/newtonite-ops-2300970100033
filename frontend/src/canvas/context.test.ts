import type { ItemCard, Workflow } from '@nops/shared';
import { describe, expect, it } from 'vitest';
import { describeActivity } from '../lib/activity';
import { moveTargets } from './context';

const wf: Workflow = {
  version: 1,
  warnings: [],
  stages: [
    { id: 'open', name: 'Open', kind: 'start', requiresApproval: false, sortOrder: 0, version: 1 },
    { id: 'prog', name: 'In Progress', kind: 'active', requiresApproval: false, sortOrder: 1, version: 1 },
    { id: 'wait', name: 'Awaiting Approval', kind: 'active', requiresApproval: false, sortOrder: 2, version: 1 },
    { id: 'ok', name: 'Approved', kind: 'done', requiresApproval: true, sortOrder: 3, version: 1 },
  ],
  transitions: [
    { id: 't1', fromStageId: 'open', toStageId: 'prog', label: null, requiresReason: false, leadOnly: false, version: 1 },
    { id: 't2', fromStageId: 'prog', toStageId: 'wait', label: null, requiresReason: false, leadOnly: false, version: 1 },
    { id: 't3', fromStageId: 'wait', toStageId: 'ok', label: 'Approve', requiresReason: false, leadOnly: false, version: 1 },
    { id: 't4', fromStageId: 'wait', toStageId: 'prog', label: 'Reject', requiresReason: true, leadOnly: true, version: 1 },
  ],
};

const card = (over: Partial<ItemCard> = {}): ItemCard =>
  ({
    id: 'i1',
    stage: { id: 'wait', name: 'Awaiting Approval', kind: 'active' },
    assignee: { id: 'meera' },
    createdBy: { id: 'meera' },
    isBlocked: false,
    ...over,
  }) as ItemCard;

describe('canvas drop hints mirror the server rules', () => {
  it('members can only move their own cards, and never approve', () => {
    expect([...moveTargets(wf, card(), 'meera', 'member')]).toEqual([]);
    expect([...moveTargets(wf, card({ stage: { id: 'prog', name: '', kind: 'active' } }), 'meera', 'member')]).toEqual(['wait']);
    expect([...moveTargets(wf, card({ stage: { id: 'prog', name: '', kind: 'active' } }), 'rohan', 'member')]).toEqual([]);
  });

  it('a lead who is not creator/assignee can approve and reject', () => {
    expect([...moveTargets(wf, card(), 'ravi', 'lead')].sort()).toEqual(['ok', 'prog']);
  });

  it('a lead cannot approve their own work; blocked items cannot finish', () => {
    expect([...moveTargets(wf, card({ assignee: { id: 'ravi' } as any }), 'ravi', 'lead')]).toEqual(['prog']);
    expect([...moveTargets(wf, card({ isBlocked: true }), 'anita', 'manager')]).toEqual(['prog']);
  });
});

describe('activity wording', () => {
  it('describes changes with their values', () => {
    expect(describeActivity({ type: 'item.updated', data: { changes: { priority: [3, 1] } } })).toBe('changed priority P3 → P1');
    expect(describeActivity({ type: 'item.approved', data: { from: { name: 'Awaiting' }, to: { name: 'Approved' } } })).toContain('approved');
  });
});
