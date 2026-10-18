import type { CanvasData, ItemCard, ProjectRole, Stage, Workflow } from '@nops/shared';
import { createContext, useContext } from 'react';
import type { ElementChange } from './sync';

export interface CanvasCtx {
  data: CanvasData;
  meId: string;
  role: ProjectRole | null;
  canEdit: boolean;
  save: (changes: ElementChange[]) => void;
  openItem: (id: string) => void;
  claim: (item: ItemCard) => void;
  dropOnStage: (item: ItemCard, stage: Stage) => void;
  dragging: ItemCard | null;
  setDragging: (i: ItemCard | null) => void;
  editProject: () => void;
  /** Element ids selected by other people → their colour. */
  othersSelection: Map<string, string>;
}

export const CanvasContext = createContext<CanvasCtx | null>(null);
export const useCanvasCtx = () => useContext(CanvasContext)!;

/**
 * Which stages a card may be dropped on: a UI hint that mirrors the server's checkTransition rules
 * (docs/04 §4.3). The server still decides; a wrong hint just means a snap-back with its message.
 */
export function moveTargets(wf: Workflow, item: ItemCard, meId: string, role: ProjectRole | null): Set<string> {
  const isLead = role === 'lead' || role === 'manager';
  if (!isLead && item.assignee?.id !== meId) return new Set();
  const result = new Set<string>();
  for (const t of wf.transitions) {
    if (t.fromStageId !== item.stage.id) continue;
    const to = wf.stages.find((s) => s.id === t.toStageId);
    if (!to) continue;
    if (t.leadOnly && !isLead) continue;
    if (to.requiresApproval && (!isLead || item.createdBy.id === meId || item.assignee?.id === meId)) continue;
    if (to.kind === 'done' && item.isBlocked) continue;
    result.add(to.id);
  }
  return result;
}
