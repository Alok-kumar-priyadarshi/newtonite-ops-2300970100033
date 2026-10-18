import { describe, expect, it } from 'vitest';
import { ACTIONS } from '@nops/shared';
import type { Actor } from '../../src/domain/actor';
import { AppError } from '../../src/domain/errors';
import { can, MATRIX } from '../../src/domain/permissions';
import { allowedTransitions, blockedTransitions, checkTransition } from '../../src/domain/transitions';
import { analyzeWorkflow, type GraphStage, type GraphTransition } from '../../src/domain/workflow-graph';

// Approval workflow: Open → In Progress → Awaiting → Approved🔒 → Closed, Awaiting → In Progress (reject)
const S = (id: string, kind: GraphStage['kind'], requiresApproval = false): GraphStage => ({ id, name: id, kind, requiresApproval });
const T = (from: string, to: string, extra: Partial<GraphTransition> = {}): GraphTransition => ({
  id: `${from}-${to}`,
  fromStageId: from,
  toStageId: to,
  label: null,
  requiresReason: false,
  leadOnly: false,
  ...extra,
});
const stages = [S('open', 'start'), S('progress', 'active'), S('awaiting', 'active'), S('approved', 'done', true), S('closed', 'done')];
const transitions = [
  T('open', 'progress'),
  T('progress', 'awaiting'),
  T('awaiting', 'approved'),
  T('awaiting', 'progress', { requiresReason: true, leadOnly: true }),
  T('approved', 'closed'),
];
const wf = { stages, transitions };
const item = (over: Partial<Parameters<typeof checkTransition>[1]> = {}) => ({
  stageId: 'awaiting',
  assigneeId: 'member',
  createdBy: 'member',
  version: 3,
  deleted: false,
  openBlockerCount: 0,
  ...over,
});
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return (e as AppError).code;
  }
};

describe('checkTransition', () => {
  it('lets a Lead who is neither creator nor assignee approve', () => {
    const d = checkTransition(wf, item(), { id: 'lead', role: 'lead' }, { toStageId: 'approved', version: 3 });
    expect(d.eventType).toBe('item.approved');
  });

  it.each([
    ['no connection (open → closed)', item({ stageId: 'open' }), { id: 'lead', role: 'lead' }, 'closed', undefined, 'INVALID_TRANSITION'],
    ['member moving an item not assigned to them', item({ stageId: 'open', assigneeId: 'other' }), { id: 'member', role: 'member' }, 'progress', undefined, 'NOT_ASSIGNEE'],
    ['member approving', item(), { id: 'member', role: 'member' }, 'approved', undefined, 'APPROVAL_ROLE_REQUIRED'],
    ['lead approving their own item', item({ createdBy: 'lead' }), { id: 'lead', role: 'lead' }, 'approved', undefined, 'SELF_APPROVAL_FORBIDDEN'],
    ['lead approving item assigned to them', item({ assigneeId: 'lead' }), { id: 'lead', role: 'lead' }, 'approved', undefined, 'SELF_APPROVAL_FORBIDDEN'],
    ['member using a lead-only reject', item(), { id: 'member', role: 'member' }, 'progress', 'why', 'LEAD_OR_MANAGER_REQUIRED'],
    ['reject without a reason', item(), { id: 'lead', role: 'lead' }, 'progress', undefined, 'REASON_REQUIRED'],
    ['finishing while blocked', item({ openBlockerCount: 2 }), { id: 'lead', role: 'lead' }, 'approved', undefined, 'BLOCKED_BY_OPEN_ITEMS'],
    ['moving a deleted item', item({ deleted: true }), { id: 'lead', role: 'lead' }, 'approved', undefined, 'ITEM_DELETED'],
  ] as const)('rejects %s', (_name, it_, actor, to, reason, code) => {
    expect(codeOf(() => checkTransition(wf, it_, actor as any, { toStageId: to, version: 3, reason }))).toBe(code);
  });

  it('checks the version last, so a conflict means a valid request lost the race', () => {
    expect(codeOf(() => checkTransition(wf, item(), { id: 'lead', role: 'lead' }, { toStageId: 'approved', version: 2 }))).toBe(
      'VERSION_CONFLICT',
    );
  });

  it('labels reject and reopen events', () => {
    expect(checkTransition(wf, item(), { id: 'lead', role: 'lead' }, { toStageId: 'progress', version: 3, reason: 'x' }).eventType).toBe(
      'item.rejected',
    );
  });

  it('a move between two done stages is not a reopen', () => {
    const wf2 = { stages: [...stages, S('archive', 'done')], transitions: [...transitions, T('closed', 'archive')] };
    const d = checkTransition(wf2, item({ stageId: 'closed' }), { id: 'lead', role: 'lead' }, { toStageId: 'archive', version: 3 });
    expect(d.eventType).toBe('item.transitioned');
    const back = { stages, transitions: [...transitions, T('closed', 'progress')] };
    expect(checkTransition(back, item({ stageId: 'closed' }), { id: 'lead', role: 'lead' }, { toStageId: 'progress', version: 3 }).eventType).toBe(
      'item.reopened',
    );
  });

  it('blockedTransitions explains every move the actor cannot make', () => {
    const blocked = blockedTransitions(wf, item({ createdBy: 'lead' }), { id: 'lead', role: 'lead' });
    expect(blocked.map((b) => [b.toStageId, b.code])).toEqual([['approved', 'SELF_APPROVAL_FORBIDDEN']]);
    expect(blocked[0].reason).toMatch(/someone else must approve/);
  });

  it('allowedTransitions uses the same rules as checkTransition', () => {
    const forMember = allowedTransitions(wf, item(), { id: 'member', role: 'member' });
    expect(forMember).toEqual([]); // cannot approve, cannot use lead-only reject
    const forLead = allowedTransitions(wf, item(), { id: 'lead', role: 'lead' }).map((t) => t.toStageId);
    expect(forLead.sort()).toEqual(['approved', 'progress']);
  });
});

describe('analyzeWorkflow', () => {
  it('accepts the approval template', () => {
    expect(analyzeWorkflow(stages, transitions).error).toBeNull();
  });

  it('rejects a shortcut that skips approval (I4)', () => {
    expect(analyzeWorkflow(stages, [...transitions, T('progress', 'closed')]).error).toBe('APPROVAL_BYPASS');
  });

  it('allows a new step inserted before approval', () => {
    const s2 = [...stages, S('bank', 'active')];
    const t2 = transitions.filter((t) => t.id !== 'progress-awaiting').concat(T('progress', 'bank'), T('bank', 'awaiting'));
    expect(analyzeWorkflow(s2, t2).error).toBeNull();
  });

  it('requires exactly one start stage (I1)', () => {
    expect(analyzeWorkflow([...stages, S('open2', 'start')], transitions).error).toBe('START_STAGE');
  });

  it('warns about detached, unreachable and dead-end stages without rejecting', () => {
    const s2 = [...stages, S('draft', 'active'), S('stuck', 'active')];
    const r = analyzeWorkflow(s2, [...transitions, T('progress', 'stuck')]);
    expect(r.error).toBeNull();
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        { code: 'DETACHED_STAGE', stageId: 'draft' },
        { code: 'DEAD_END', stageId: 'stuck' },
      ]),
    );
  });
});

describe('permission matrix', () => {
  const actor = (role: 'manager' | 'lead' | 'member' | null, isAdmin = false): Actor => ({
    id: 'me',
    orgId: 'o',
    fullName: 'Me',
    isAdmin,
    roles: new Map(role ? [['p', role]] : []),
  });

  it('matches docs/06-permissions.md for every action and role', () => {
    for (const action of ACTIONS) {
      for (const role of ['manager', 'lead', 'member'] as const) {
        expect(can(actor(role), action, { projectId: 'p' })).toBe(MATRIX[action].roles.includes(role));
      }
      expect(can(actor(null), action, { projectId: 'p' })).toBe(false);
    }
  });

  it('only the Manager can delete', () => {
    expect(can(actor('manager'), 'item.delete', { projectId: 'p' })).toBe(true);
    expect(can(actor('lead'), 'item.delete', { projectId: 'p' })).toBe(false);
    expect(can(actor('member'), 'item.delete', { projectId: 'p' })).toBe(false);
  });

  it('members may move only their own items', () => {
    expect(can(actor('member'), 'item.transition', { projectId: 'p', assigneeId: 'me' })).toBe(true);
    expect(can(actor('member'), 'item.transition', { projectId: 'p', assigneeId: 'other' })).toBe(false);
  });

  it('admins without a role get metadata and member management only', () => {
    expect(can(actor(null, true), 'project.view_meta', { projectId: 'p' })).toBe(true);
    expect(can(actor(null, true), 'project.manage_members', { projectId: 'p' })).toBe(true);
    expect(can(actor(null, true), 'project.view', { projectId: 'p' })).toBe(false);
    expect(can(actor(null, true), 'item.delete', { projectId: 'p' })).toBe(false);
  });
});
