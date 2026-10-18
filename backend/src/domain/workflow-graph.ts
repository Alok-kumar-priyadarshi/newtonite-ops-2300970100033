import type { StageKind, WorkflowWarning } from '@nops/shared';

export interface GraphStage {
  id: string;
  name: string;
  kind: StageKind;
  requiresApproval: boolean;
}

export interface GraphTransition {
  id: string;
  fromStageId: string;
  toStageId: string;
  label: string | null;
  requiresReason: boolean;
  leadOnly: boolean;
}

export type WorkflowError = 'START_STAGE' | 'APPROVAL_BYPASS';

export interface WorkflowAnalysis {
  /** A hard rule is broken: the edit must be rejected. */
  error: WorkflowError | null;
  /** Soft problems shown on the canvas while people are still editing. */
  warnings: WorkflowWarning[];
}

function reachableFrom(starts: string[], next: Map<string, string[]>, skip: (id: string) => boolean = () => false) {
  const seen = new Set<string>();
  const queue = starts.filter((s) => !skip(s));
  queue.forEach((s) => seen.add(s));
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of next.get(id) ?? []) {
      if (seen.has(n) || skip(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

/**
 * Validates a workflow graph (docs/04-workflow-rules.md §4.4).
 *
 * Hard rules (edit rejected):
 *   I1  exactly one start stage
 *   I4  no approval bypass: with protected stages removed, no `done` stage is reachable from start
 * Soft rules (warnings, because the graph is often mid-edit on the canvas):
 *   unreachable stages, dead ends (no way to a done stage), detached stages (no connections yet)
 */
export function analyzeWorkflow(stages: GraphStage[], transitions: GraphTransition[]): WorkflowAnalysis {
  const starts = stages.filter((s) => s.kind === 'start');
  if (starts.length !== 1) return { error: 'START_STAGE', warnings: [] };
  const startId = starts[0].id;

  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  const connected = new Set<string>();
  for (const t of transitions) {
    forward.set(t.fromStageId, [...(forward.get(t.fromStageId) ?? []), t.toStageId]);
    backward.set(t.toStageId, [...(backward.get(t.toStageId) ?? []), t.fromStageId]);
    connected.add(t.fromStageId);
    connected.add(t.toStageId);
  }

  const byId = new Map(stages.map((s) => [s.id, s]));

  // I4 — approval bypass. The start stage is the entry point even if someone protected it.
  if (stages.some((s) => s.requiresApproval)) {
    const unprotectedReach = reachableFrom([startId], forward, (id) => id !== startId && !!byId.get(id)?.requiresApproval);
    const bypass = [...unprotectedReach].some((id) => byId.get(id)?.kind === 'done' && !byId.get(id)?.requiresApproval);
    if (bypass) return { error: 'APPROVAL_BYPASS', warnings: [] };
  }

  const warnings: WorkflowWarning[] = [];
  const reachable = reachableFrom([startId], forward);
  const canFinish = reachableFrom(
    stages.filter((s) => s.kind === 'done').map((s) => s.id),
    backward,
  );
  for (const s of stages) {
    if (s.id !== startId && !connected.has(s.id)) {
      warnings.push({ code: 'DETACHED_STAGE', stageId: s.id });
      continue;
    }
    if (!reachable.has(s.id)) warnings.push({ code: 'UNREACHABLE_STAGE', stageId: s.id });
    else if (s.kind !== 'done' && !canFinish.has(s.id)) warnings.push({ code: 'DEAD_END', stageId: s.id });
  }
  return { error: null, warnings };
}
