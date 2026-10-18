import type { StageKind, WorkflowTemplate } from '@nops/shared';

export interface TemplateStage {
  key: string;
  name: string;
  kind: StageKind;
  requiresApproval?: boolean;
}
export interface TemplateTransition {
  from: string;
  to: string;
  label?: string;
  requiresReason?: boolean;
  leadOnly?: boolean;
}

/** Starting workflows (docs/04-workflow-rules.md §4.2). Projects copy one and can edit it after. */
export const TEMPLATES: Record<WorkflowTemplate, { stages: TemplateStage[]; transitions: TemplateTransition[] }> = {
  standard: {
    stages: [
      { key: 'open', name: 'Open', kind: 'start' },
      { key: 'progress', name: 'In Progress', kind: 'active' },
      { key: 'resolved', name: 'Resolved', kind: 'done' },
      { key: 'closed', name: 'Closed', kind: 'done' },
    ],
    transitions: [
      { from: 'open', to: 'progress' },
      { from: 'progress', to: 'open', label: 'Return to queue' },
      { from: 'progress', to: 'resolved' },
      { from: 'resolved', to: 'progress', label: 'Reopen', requiresReason: true, leadOnly: true },
      { from: 'resolved', to: 'closed' },
    ],
  },
  approval: {
    stages: [
      { key: 'open', name: 'Open', kind: 'start' },
      { key: 'progress', name: 'In Progress', kind: 'active' },
      { key: 'awaiting', name: 'Awaiting Approval', kind: 'active' },
      { key: 'approved', name: 'Approved', kind: 'done', requiresApproval: true },
      { key: 'closed', name: 'Closed', kind: 'done' },
    ],
    transitions: [
      { from: 'open', to: 'progress' },
      { from: 'progress', to: 'awaiting', label: 'Request approval' },
      { from: 'awaiting', to: 'approved', label: 'Approve' },
      { from: 'awaiting', to: 'progress', label: 'Reject', requiresReason: true, leadOnly: true },
      { from: 'approved', to: 'progress', label: 'Reopen', requiresReason: true, leadOnly: true },
      { from: 'approved', to: 'closed' },
    ],
  },
  incident: {
    stages: [
      { key: 'open', name: 'Open', kind: 'start' },
      { key: 'investigating', name: 'Investigating', kind: 'active' },
      { key: 'mitigated', name: 'Mitigated', kind: 'active' },
      { key: 'resolved', name: 'Resolved', kind: 'done' },
      { key: 'closed', name: 'Closed', kind: 'done' },
    ],
    transitions: [
      { from: 'open', to: 'investigating' },
      { from: 'investigating', to: 'mitigated' },
      { from: 'mitigated', to: 'investigating', label: 'Regressed', requiresReason: true },
      { from: 'mitigated', to: 'resolved' },
      { from: 'resolved', to: 'investigating', label: 'Reopen', requiresReason: true, leadOnly: true },
      { from: 'resolved', to: 'closed' },
    ],
  },
};

/** Default canvas layout: project node top-left, stage frames left to right below it. */
export const LAYOUT = {
  projectNode: { x: 80, y: 40, width: 440, height: 230 },
  // 130px between frames leaves room for connection labels.
  frame: (index: number) => ({ x: 80 + index * 470, y: 340, width: 340, height: 640 }),
};
