import type { Stage, StageKind, Transition, Workflow } from '@nops/shared';
import type { Sql, Tx } from '../db';
import type { Actor } from '../domain/actor';
import { AppError, notFound } from '../domain/errors';
import { authorize } from '../domain/permissions';
import { analyzeWorkflow } from '../domain/workflow-graph';
import { recordEvent } from './activity';

interface StageRow {
  id: string;
  name: string;
  kind: StageKind;
  requires_approval: boolean;
  sort_order: number;
  version: number;
}
interface TransitionRow {
  id: string;
  from_stage_id: string;
  to_stage_id: string;
  label: string | null;
  requires_reason: boolean;
  lead_only: boolean;
  version: number;
}

const toStage = (r: StageRow): Stage => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  requiresApproval: r.requires_approval,
  sortOrder: r.sort_order,
  version: r.version,
});
const toTransition = (r: TransitionRow): Transition => ({
  id: r.id,
  fromStageId: r.from_stage_id,
  toStageId: r.to_stage_id,
  label: r.label,
  requiresReason: r.requires_reason,
  leadOnly: r.lead_only,
  version: r.version,
});

export async function loadWorkflow(db: Sql, projectId: string): Promise<Workflow> {
  const [[wf], stages, transitions] = await Promise.all([
    db<{ version: number }[]>`select version from workflows where project_id = ${projectId}`,
    db<StageRow[]>`
      select id, name, kind, requires_approval, sort_order, version from workflow_stages
      where project_id = ${projectId} and deleted_at is null order by sort_order, created_at`,
    db<TransitionRow[]>`
      select id, from_stage_id, to_stage_id, label, requires_reason, lead_only, version from workflow_transitions
      where project_id = ${projectId} and deleted_at is null order by created_at`,
  ]);
  if (!wf) throw notFound('Project');
  const s = stages.map(toStage);
  const t = transitions.map(toTransition);
  return { version: wf.version, stages: s, transitions: t, warnings: analyzeWorkflow(s, t).warnings };
}

/**
 * Every workflow edit runs through here: lock the workflow row (serializes edits to this project's
 * workflow and waits for in-flight item transitions, which hold FOR SHARE), apply the edit, then
 * validate the *resulting* graph. A broken hard rule throws and rolls the whole edit back.
 */
async function editWorkflow(
  tx: Tx,
  actor: Actor,
  projectId: string,
  needsRules: boolean,
  edit: () => Promise<{ type: string; data: Record<string, unknown> }>,
): Promise<Workflow> {
  authorize(actor, 'workflow.edit_structure', { projectId });
  if (needsRules) authorize(actor, 'workflow.edit_rules', { projectId });
  const [locked] = await tx`select version from workflows where project_id = ${projectId} for update`;
  if (!locked) throw notFound('Project');

  const event = await edit();

  const wf = await loadWorkflow(tx, projectId);
  const { error } = analyzeWorkflow(wf.stages, wf.transitions);
  if (error === 'START_STAGE') {
    throw new AppError('WORKFLOW_INVALID', 'A workflow needs exactly one start stage.', { reason: error });
  }
  if (error === 'APPROVAL_BYPASS') {
    throw new AppError(
      'WORKFLOW_INVALID',
      'This change would let items reach a finished stage without approval.',
      { reason: error },
    );
  }
  const [bumped] = await tx<{ version: number }[]>`
    update workflows set version = version + 1, updated_by = ${actor.id}, updated_at = now()
    where project_id = ${projectId} returning version`;
  await recordEvent(tx, { projectId, actor, type: event.type, data: event.data });
  return { ...wf, version: bumped.version };
}

async function getStage(tx: Tx, projectId: string, stageId: string) {
  const [s] = await tx<StageRow[]>`
    select id, name, kind, requires_approval, sort_order, version from workflow_stages
    where id = ${stageId} and project_id = ${projectId} and deleted_at is null`;
  if (!s) throw notFound('Stage');
  return s;
}

async function getTransition(tx: Tx, projectId: string, transitionId: string) {
  const [t] = await tx<(TransitionRow & { from_name: string; to_name: string; to_protected: boolean })[]>`
    select t.id, t.from_stage_id, t.to_stage_id, t.label, t.requires_reason, t.lead_only, t.version,
           f.name as from_name, s.name as to_name, s.requires_approval as to_protected
    from workflow_transitions t
    join workflow_stages f on f.id = t.from_stage_id
    join workflow_stages s on s.id = t.to_stage_id
    where t.id = ${transitionId} and t.project_id = ${projectId} and t.deleted_at is null`;
  if (!t) throw notFound('Connection');
  return t;
}

async function assertNameFree(tx: Tx, projectId: string, name: string, exceptId?: string) {
  const [clash] = await tx`
    select id from workflow_stages
    where project_id = ${projectId} and deleted_at is null and lower(name) = lower(${name})
      and id <> ${exceptId ?? '00000000-0000-0000-0000-000000000000'}`;
  if (clash) throw new AppError('STAGE_NAME_TAKEN', `A stage called "${name}" already exists.`);
}

export interface AddStageInput {
  id: string;
  name: string;
  kind: StageKind;
  requiresApproval: boolean;
  frame: { x: number; y: number; width: number; height: number };
  insertOnTransitionId?: string;
  keepOriginalTransition: boolean;
}

export async function addStage(tx: Tx, actor: Actor, projectId: string, input: AddStageInput) {
  // Idempotent by client-generated id.
  const [existing] = await tx`select id from workflow_stages where id = ${input.id}`;
  if (existing) return loadWorkflow(tx, projectId);

  const needsRules = input.kind !== 'active' || input.requiresApproval;
  return editWorkflow(tx, actor, projectId, needsRules, async () => {
    await assertNameFree(tx, projectId, input.name);
    if (input.kind === 'start') {
      await tx`update workflow_stages set kind = 'active', version = version + 1, updated_at = now()
               where project_id = ${projectId} and kind = 'start' and deleted_at is null`;
    }
    await tx`
      insert into workflow_stages (id, project_id, name, kind, requires_approval, sort_order)
      values (${input.id}, ${projectId}, ${input.name}, ${input.kind}, ${input.requiresApproval},
              (select coalesce(max(sort_order), 0) + 1 from workflow_stages where project_id = ${projectId}))`;
    await tx`
      insert into canvas_elements (id, project_id, type, stage_id, x, y, width, height, created_by, updated_by)
      values (gen_random_uuid(), ${projectId}, 'stage_frame', ${input.id},
              ${input.frame.x}, ${input.frame.y}, ${input.frame.width}, ${input.frame.height}, ${actor.id}, ${actor.id})`;

    const data: Record<string, unknown> = { stageId: input.id, name: input.name, kind: input.kind };
    if (input.insertOnTransitionId) {
      // "Add a step between two steps": A→B becomes A→new→B (and optionally keeps A→B).
      const t = await getTransition(tx, projectId, input.insertOnTransitionId);
      if (t.requires_reason || t.lead_only || t.to_protected) {
        if (!input.keepOriginalTransition) authorize(actor, 'workflow.edit_rules', { projectId });
      }
      await tx`
        insert into workflow_transitions (project_id, from_stage_id, to_stage_id, created_by)
        values (${projectId}, ${t.from_stage_id}, ${input.id}, ${actor.id}),
               (${projectId}, ${input.id}, ${t.to_stage_id}, ${actor.id})`;
      if (!input.keepOriginalTransition) {
        await tx`update workflow_transitions set deleted_at = now(), updated_at = now() where id = ${t.id}`;
      }
      data.between = { from: t.from_name, to: t.to_name };
    }
    return { type: 'workflow.stage_added', data };
  });
}

export async function patchStage(
  tx: Tx,
  actor: Actor,
  projectId: string,
  stageId: string,
  input: { version: number; name?: string; kind?: StageKind; requiresApproval?: boolean },
) {
  const needsRules = input.kind !== undefined || input.requiresApproval !== undefined;
  return editWorkflow(tx, actor, projectId, needsRules, async () => {
    const s = await getStage(tx, projectId, stageId);
    if (s.version !== input.version) {
      throw new AppError('VERSION_CONFLICT', `Stage "${s.name}" was changed by someone else.`, { current: toStage(s) });
    }
    if (input.name !== undefined) await assertNameFree(tx, projectId, input.name, stageId);
    if (input.kind === 'start' && s.kind !== 'start') {
      await tx`update workflow_stages set kind = 'active', version = version + 1, updated_at = now()
               where project_id = ${projectId} and kind = 'start' and deleted_at is null`;
    }
    await tx`
      update workflow_stages set
        name = ${input.name ?? s.name},
        kind = ${input.kind ?? s.kind},
        requires_approval = ${input.requiresApproval ?? s.requires_approval},
        version = version + 1, updated_at = now()
      where id = ${stageId}`;
    return { type: 'workflow.stage_updated', data: { stageId, name: input.name ?? s.name, before: toStage(s), changes: input } };
  });
}

export async function deleteStage(tx: Tx, actor: Actor, projectId: string, stageId: string) {
  // Peek first to know whether this needs rule permissions; re-read under the lock below.
  const [peek] = await tx<StageRow[]>`select requires_approval, kind from workflow_stages where id = ${stageId} and project_id = ${projectId}`;
  const needsRules = Boolean(peek?.requires_approval || peek?.kind !== 'active');
  return editWorkflow(tx, actor, projectId, needsRules, async () => {
    const s = await getStage(tx, projectId, stageId);
    if (s.kind === 'start') {
      throw new AppError('WORKFLOW_INVALID', 'The start stage cannot be deleted.', { reason: 'START_STAGE' });
    }
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from work_items where stage_id = ${stageId} and deleted_at is null`;
    if (n > 0) {
      throw new AppError('STAGE_NOT_EMPTY', `${n} item(s) are in "${s.name}". Move them first.`, { itemCount: n });
    }
    await tx`update workflow_stages set deleted_at = now(), updated_at = now(), version = version + 1 where id = ${stageId}`;
    await tx`update workflow_transitions set deleted_at = now(), updated_at = now()
             where (from_stage_id = ${stageId} or to_stage_id = ${stageId}) and deleted_at is null`;
    await tx`update canvas_elements set deleted_at = now(), deleted_by = ${actor.id}, updated_at = now(), version = version + 1
             where stage_id = ${stageId} and deleted_at is null`;
    return { type: 'workflow.stage_removed', data: { stageId, name: s.name } };
  });
}

export async function addTransition(
  tx: Tx,
  actor: Actor,
  projectId: string,
  input: { id: string; fromStageId: string; toStageId: string; label?: string | null; requiresReason: boolean; leadOnly: boolean },
) {
  const [existing] = await tx`select id from workflow_transitions where id = ${input.id}`;
  if (existing) return loadWorkflow(tx, projectId);
  const needsRules = input.requiresReason || input.leadOnly;
  return editWorkflow(tx, actor, projectId, needsRules, async () => {
    if (input.fromStageId === input.toStageId) {
      throw new AppError('VALIDATION_FAILED', 'A connection must join two different stages.');
    }
    const from = await getStage(tx, projectId, input.fromStageId);
    const to = await getStage(tx, projectId, input.toStageId);
    const [dup] = await tx`
      select id from workflow_transitions
      where from_stage_id = ${from.id} and to_stage_id = ${to.id} and deleted_at is null`;
    if (dup) throw new AppError('VALIDATION_FAILED', `"${from.name}" is already connected to "${to.name}".`);
    await tx`
      insert into workflow_transitions (id, project_id, from_stage_id, to_stage_id, label, requires_reason, lead_only, created_by)
      values (${input.id}, ${projectId}, ${from.id}, ${to.id}, ${input.label ?? null},
              ${input.requiresReason}, ${input.leadOnly}, ${actor.id})`;
    return {
      type: 'workflow.transition_added',
      data: { transitionId: input.id, fromName: from.name, toName: to.name },
    };
  });
}

export async function patchTransition(
  tx: Tx,
  actor: Actor,
  projectId: string,
  transitionId: string,
  input: { version: number; label?: string | null; requiresReason?: boolean; leadOnly?: boolean },
) {
  const needsRules = input.requiresReason !== undefined || input.leadOnly !== undefined;
  return editWorkflow(tx, actor, projectId, needsRules, async () => {
    const t = await getTransition(tx, projectId, transitionId);
    if (t.version !== input.version) {
      throw new AppError('VERSION_CONFLICT', 'This connection was changed by someone else.', {
        current: toTransition(t),
      });
    }
    await tx`
      update workflow_transitions set
        label = ${input.label === undefined ? t.label : input.label},
        requires_reason = ${input.requiresReason ?? t.requires_reason},
        lead_only = ${input.leadOnly ?? t.lead_only},
        version = version + 1, updated_at = now()
      where id = ${transitionId}`;
    return {
      type: 'workflow.transition_updated',
      data: { transitionId, fromName: t.from_name, toName: t.to_name, changes: input },
    };
  });
}

export async function deleteTransition(tx: Tx, actor: Actor, projectId: string, transitionId: string) {
  const [peek] = await tx<{ guarded: boolean }[]>`
    select (t.requires_reason or t.lead_only or s.requires_approval) as guarded
    from workflow_transitions t join workflow_stages s on s.id = t.to_stage_id
    where t.id = ${transitionId} and t.project_id = ${projectId}`;
  return editWorkflow(tx, actor, projectId, Boolean(peek?.guarded), async () => {
    const t = await getTransition(tx, projectId, transitionId);
    await tx`update workflow_transitions set deleted_at = now(), updated_at = now() where id = ${transitionId}`;
    return { type: 'workflow.transition_removed', data: { transitionId, fromName: t.from_name, toName: t.to_name } };
  });
}
