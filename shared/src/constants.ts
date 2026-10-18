export const PROJECT_ROLES = ['manager', 'lead', 'member'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const ITEM_TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const STAGE_KINDS = ['start', 'active', 'done'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track', 'done'] as const;
export type ProjectHealth = (typeof PROJECT_HEALTH)[number];

export const NOTE_KINDS = ['note', 'decision', 'handoff', 'blocker'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const WORKFLOW_TEMPLATES = ['standard', 'approval', 'incident'] as const;
export type WorkflowTemplate = (typeof WORKFLOW_TEMPLATES)[number];

export const DRAWING_ELEMENT_TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'sticky', 'arrow', 'freehand'] as const;
export const CANVAS_ELEMENT_TYPES = ['project_node', 'stage_frame', ...DRAWING_ELEMENT_TYPES] as const;
export type CanvasElementType = (typeof CANVAS_ELEMENT_TYPES)[number];

export const ITEM_VIEWS = [
  'assigned_to_me',
  'next_actions_due',
  'overdue',
  'awaiting_my_approval',
  'unassigned_urgent',
  'blocked',
  'forgotten',
] as const;
export type ItemView = (typeof ITEM_VIEWS)[number];

/** Every action the permission system knows about. */
export const ACTIONS = [
  'project.view',
  'project.view_meta',
  'project.edit_status',
  'project.edit_details',
  'project.manage_members',
  'item.create',
  'item.claim',
  'item.release',
  'item.transition',
  'item.assign',
  'item.edit_priority',
  'item.edit_next_action',
  'item.edit_details',
  'item.delete',
  'item.restore',
  'item.comment',
  'item.link',
  'canvas.edit',
  'workflow.edit_structure',
  'workflow.edit_rules',
] as const;
export type Action = (typeof ACTIONS)[number];

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'newtonite-ops';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const LIMITS = {
  pageSizeDefault: 50,
  pageSizeMax: 100,
  canvasElementsPerProject: 2000,
  canvasBatch: 100,
  stageCardsOnCanvas: 20,
  forgottenDays: 5,
  totalCountCap: 10000,
} as const;
