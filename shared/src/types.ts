import type {
  CanvasElementType,
  ItemType,
  ProjectHealth,
  ProjectRole,
  StageKind,
} from './constants';

/** Response shapes shared by the API and the web app. See docs/07-api-contracts.md §7.2. */

export interface UserMini {
  id: string;
  fullName: string;
  initials: string;
  avatarColor: string;
}

export interface WorkerMini extends UserMini {
  designation: string;
  projectRole: ProjectRole | null;
  openItemCount: number;
}

export interface Stage {
  id: string;
  name: string;
  kind: StageKind;
  requiresApproval: boolean;
  sortOrder: number;
  version: number;
}

export interface Transition {
  id: string;
  fromStageId: string;
  toStageId: string;
  label: string | null;
  requiresReason: boolean;
  leadOnly: boolean;
  version: number;
}

export interface WorkflowWarning {
  code: 'UNREACHABLE_STAGE' | 'DEAD_END' | 'DETACHED_STAGE';
  stageId: string;
}

export interface Workflow {
  version: number;
  stages: Stage[];
  transitions: Transition[];
  warnings: WorkflowWarning[];
}

export interface ItemSummary {
  id: string;
  key: string;
  number: number;
  projectId: string;
  projectKey: string;
  type: ItemType;
  title: string;
  priority: 1 | 2 | 3 | 4;
  stage: { id: string; name: string; kind: StageKind };
  assignee: WorkerMini | null;
  createdBy: UserMini;
  dueAt: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  isBlocked: boolean;
  awaitingApproval: boolean;
  isOverdue: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  deleted?: true;
  deletedAt?: string | null;
}

export interface ItemCard extends ItemSummary {
  descriptionExcerpt: string;
  lastChange: { actor: UserMini | null; summary: string; at: string } | null;
  noteCount: number;
}

export interface AllowedTransition {
  transitionId: string;
  toStageId: string;
  toStageName: string;
  label: string | null;
  requiresReason: boolean;
  isApproval: boolean;
}

/** A move that exists in the workflow but that this person can't make right now, and why. */
export interface BlockedTransition {
  transitionId: string;
  toStageId: string;
  toStageName: string;
  label: string | null;
  code: string;
  reason: string;
}

export interface ItemDetail extends ItemSummary {
  description: string;
  blockers: ItemSummary[];
  blocking: ItemSummary[];
  permissions: string[];
  allowedTransitions: AllowedTransition[];
  blockedTransitions: BlockedTransition[];
  viewers: UserMini[];
  deletedBy?: UserMini | null;
  deleteReason?: string | null;
}

export interface ActivityEvent {
  id: string;
  type: string;
  actor: UserMini | null;
  actorRole: string;
  data: Record<string, any>;
  itemVersion: number | null;
  createdAt: string;
  item?: { id: string; key: string; title: string } | null;
  project?: { id: string; key: string; name: string } | null;
}

export interface CanvasElement {
  id: string;
  projectId: string;
  type: CanvasElementType;
  stageId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  props: Record<string, any>;
  version: number;
  updatedBy: UserMini | null;
  updatedAt: string;
  deleted?: true;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  team: { id: string; name: string };
  goal: string;
  statusNote: string;
  health: ProjectHealth;
  myRole: ProjectRole | null;
  manager: UserMini | null;
  leads: UserMini[];
  counts: { open: number; awaitingApproval: number; blocked: number; overdue: number };
  version: number;
  updatedAt: string;
  updatedBy: UserMini | null;
}

export interface ProjectDetail extends ProjectSummary {
  permissions: string[];
  workflow: Workflow;
}

export interface Membership {
  projectId: string;
  projectKey: string;
  projectName: string;
  teamName: string;
  role: ProjectRole;
}

export interface Me {
  user: UserMini & {
    email: string;
    designation: string;
    department: string;
    isAdmin: boolean;
  };
  memberships: Membership[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ItemListPage extends Page<ItemSummary> {
  total: number;
  totalIsCapped: boolean;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  project: { id: string; key: string; name: string };
  item: { id: string; key: string } | null;
  actor: UserMini | null;
  count: number | null;
  createdAt: string;
  readAt: string | null;
}

export interface CanvasData {
  project: ProjectDetail;
  workflow: Workflow;
  elements: CanvasElement[];
  stages: { stageId: string; count: number; items: ItemCard[] }[];
  members: WorkerMini[];
  serverTime: string;
}

export interface ChangesFeed {
  serverTime: string;
  items: ItemCard[];
  elements: CanvasElement[];
  workflow: Workflow | null;
  project: ProjectSummary | null;
  stageCounts: Record<string, number>;
  resync: boolean;
}

export interface Dashboard {
  counts: {
    assignedToMe: number;
    nextActionsDue: number;
    overdue: number;
    awaitingMyApproval: number;
    unassignedUrgent: number;
    blocked: number;
    forgotten: number;
  };
  dueSoon: ItemSummary[];
}

export interface VersionConflictDetails<T> {
  current: T;
  changes: { field: string; from: unknown; to: unknown; by: UserMini | null; at: string; eventId: string }[];
}

export interface PersonProfile {
  user: UserMini & {
    email: string;
    designation: string;
    department: string;
    employeeCode: string;
    joinedAt: string;
  };
  online: boolean;
  currentProjects: { project: { id: string; key: string; name: string }; role: ProjectRole; since: string; openItems: number }[];
}

export interface AssistantReply {
  answer: string;
  /** Items mentioned in the answer, so the UI can link them. */
  references: { id: string; key: string; title: string }[];
  /** Which lookups the assistant made, shown for transparency ("Searched items…"). */
  steps: { tool: string; label: string }[];
}

export interface RoleHistoryRow {
  project: { id: string; key: string; name: string };
  role: ProjectRole;
  validFrom: string;
  validTo: string | null;
  reason: string | null;
}
