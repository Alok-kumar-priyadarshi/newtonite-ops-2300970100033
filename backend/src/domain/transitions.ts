import type { AllowedTransition, BlockedTransition, ProjectRole } from '@nops/shared';
import { AppError } from './errors';
import type { GraphStage, GraphTransition } from './workflow-graph';

export interface TransitionWorkflow {
  stages: GraphStage[];
  transitions: GraphTransition[];
}

export interface TransitionItem {
  stageId: string;
  assigneeId: string | null;
  createdBy: string;
  version: number;
  deleted: boolean;
  openBlockerCount: number;
}

export interface TransitionActor {
  id: string;
  role: ProjectRole | null;
}

export interface TransitionRequest {
  toStageId: string;
  version: number;
  reason?: string;
}

export type TransitionEventType = 'item.approved' | 'item.rejected' | 'item.reopened' | 'item.transitioned';

export interface TransitionDecision {
  transition: GraphTransition;
  from: GraphStage;
  to: GraphStage;
  eventType: TransitionEventType;
}

const isLead = (role: ProjectRole | null) => role === 'lead' || role === 'manager';

/**
 * Rules 1–7 of docs/04-workflow-rules.md §4.3 for one candidate transition.
 * Returns the first failing rule as an AppError, or null if the move is allowed.
 * Rules 8 (reason) and 9 (version) depend on the request, not on who is moving what.
 */
function firstBlockingRule(
  wf: TransitionWorkflow,
  item: TransitionItem,
  actor: TransitionActor,
  toStageId: string,
): AppError | { transition: GraphTransition; from: GraphStage; to: GraphStage } {
  if (item.deleted) return new AppError('ITEM_DELETED', 'This item was deleted.');
  if (!isLead(actor.role) && item.assigneeId !== actor.id) {
    return new AppError('NOT_ASSIGNEE', 'Members can only move items assigned to them. Claim it first.');
  }
  const from = wf.stages.find((s) => s.id === item.stageId);
  const to = wf.stages.find((s) => s.id === toStageId);
  const transition = wf.transitions.find((t) => t.fromStageId === item.stageId && t.toStageId === toStageId);
  if (!from || !to || !transition) {
    return new AppError(
      'INVALID_TRANSITION',
      `There is no connection from "${from?.name ?? 'this stage'}" to "${to?.name ?? 'that stage'}".`,
    );
  }
  if (transition.leadOnly && !isLead(actor.role)) {
    return new AppError('LEAD_OR_MANAGER_REQUIRED', `Only a Lead or the Manager can use "${transition.label ?? to.name}".`);
  }
  if (to.requiresApproval) {
    if (!isLead(actor.role)) {
      return new AppError('APPROVAL_ROLE_REQUIRED', `Only a Lead or the Manager can approve (move to "${to.name}").`);
    }
    if (item.createdBy === actor.id || item.assigneeId === actor.id) {
      return new AppError(
        'SELF_APPROVAL_FORBIDDEN',
        'You created or are working on this item, so someone else must approve it.',
      );
    }
  }
  if (to.kind === 'done' && item.openBlockerCount > 0) {
    return new AppError(
      'BLOCKED_BY_OPEN_ITEMS',
      `This item is blocked by ${item.openBlockerCount} open item(s). Resolve them first.`,
    );
  }
  return { transition, from, to };
}

function eventTypeFor(wf: TransitionWorkflow, from: GraphStage, to: GraphStage): TransitionEventType {
  if (to.requiresApproval) return 'item.approved';
  // Done → not done is a reopen; done → done (e.g. Closed → Archive) is an ordinary move.
  if (from.kind === 'done' && to.kind !== 'done') return 'item.reopened';
  const fromLeadsToApproval = wf.transitions.some(
    (t) => t.fromStageId === from.id && wf.stages.find((s) => s.id === t.toStageId)?.requiresApproval,
  );
  if (fromLeadsToApproval && to.kind !== 'done') return 'item.rejected';
  return 'item.transitioned';
}

/** Decides whether `actor` may move `item` to `req.toStageId`. Pure: no I/O. */
export function checkTransition(
  wf: TransitionWorkflow,
  item: TransitionItem,
  actor: TransitionActor,
  req: TransitionRequest,
): TransitionDecision {
  const result = firstBlockingRule(wf, item, actor, req.toStageId);
  if (result instanceof AppError) throw result;
  const { transition, from, to } = result;
  if (transition.requiresReason && !req.reason?.trim()) {
    throw new AppError('REASON_REQUIRED', `A reason is required for "${transition.label ?? to.name}".`);
  }
  if (req.version !== item.version) {
    throw new AppError('VERSION_CONFLICT', 'This item was changed by someone else.');
  }
  return { transition, from, to, eventType: eventTypeFor(wf, from, to) };
}

/** Moves that exist from the current stage but are refused for this actor, with the reason. */
export function blockedTransitions(wf: TransitionWorkflow, item: TransitionItem, actor: TransitionActor): BlockedTransition[] {
  if (item.deleted) return [];
  return wf.transitions
    .filter((t) => t.fromStageId === item.stageId)
    .flatMap((t) => {
      const r = firstBlockingRule(wf, item, actor, t.toStageId);
      if (!(r instanceof AppError)) return [];
      const to = wf.stages.find((s) => s.id === t.toStageId);
      return [{ transitionId: t.id, toStageId: t.toStageId, toStageName: to?.name ?? '?', label: t.label, code: r.code, reason: r.message }];
    });
}

/** Every move the actor could make right now: drives buttons and canvas drop targets. */
export function allowedTransitions(wf: TransitionWorkflow, item: TransitionItem, actor: TransitionActor): AllowedTransition[] {
  return wf.transitions
    .filter((t) => t.fromStageId === item.stageId)
    .flatMap((t) => {
      const r = firstBlockingRule(wf, item, actor, t.toStageId);
      if (r instanceof AppError) return [];
      return [
        {
          transitionId: t.id,
          toStageId: r.to.id,
          toStageName: r.to.name,
          label: t.label,
          requiresReason: t.requiresReason,
          isApproval: r.to.requiresApproval,
        },
      ];
    });
}
