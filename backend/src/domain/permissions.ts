import { ACTIONS, type Action, type ErrorCode, type ProjectRole } from '@nops/shared';
import { type Actor, roleIn } from './actor';
import { AppError, notFound } from './errors';

/**
 * The permission matrix (docs/06-permissions.md §6.3). This is the only place permission
 * rules live; every route calls authorize().
 *
 *  roles  – project roles that always have the action
 *  own    – a Member may do it when they are the item's assignee
 *  admin  – a company Admin may do it even without a project role
 */
interface Rule {
  roles: ProjectRole[];
  own?: boolean;
  admin?: boolean;
  denied: ErrorCode;
  message: string;
}

const ALL: ProjectRole[] = ['manager', 'lead', 'member'];
const LEADS: ProjectRole[] = ['manager', 'lead'];
const MANAGER: ProjectRole[] = ['manager'];

const LEAD_MSG = 'Only a Project Lead or the Project Manager can do this.';
const MANAGER_MSG = 'Only the Project Manager can do this.';

export const MATRIX: Record<Action, Rule> = {
  'project.view': { roles: ALL, denied: 'NOT_FOUND', message: 'Project not found.' },
  'project.view_meta': { roles: ALL, admin: true, denied: 'NOT_FOUND', message: 'Project not found.' },
  'project.edit_status': { roles: LEADS, denied: 'LEAD_OR_MANAGER_REQUIRED', message: LEAD_MSG },
  'project.edit_details': { roles: MANAGER, admin: true, denied: 'NOT_PROJECT_MANAGER', message: MANAGER_MSG },
  'project.manage_members': {
    roles: MANAGER,
    admin: true,
    denied: 'NOT_PROJECT_MANAGER',
    message: 'Only the Project Manager can manage members.',
  },
  'item.create': { roles: ALL, denied: 'FORBIDDEN', message: 'You cannot create items here.' },
  'item.claim': { roles: ALL, denied: 'FORBIDDEN', message: 'You cannot claim this item.' },
  'item.release': {
    roles: LEADS,
    own: true,
    denied: 'NOT_ASSIGNEE',
    message: 'Only the assignee, a Lead or the Manager can release this item.',
  },
  'item.transition': {
    roles: LEADS,
    own: true,
    denied: 'NOT_ASSIGNEE',
    message: 'Members can only move items assigned to them. Claim it first.',
  },
  'item.assign': { roles: LEADS, denied: 'LEAD_OR_MANAGER_REQUIRED', message: 'Only a Lead or the Manager can reassign items.' },
  'item.edit_priority': {
    roles: LEADS,
    denied: 'LEAD_OR_MANAGER_REQUIRED',
    message: 'Only a Lead or the Manager can change priority.',
  },
  'item.edit_next_action': {
    roles: LEADS,
    own: true,
    denied: 'NOT_ASSIGNEE',
    message: 'Only the assignee, a Lead or the Manager can set the next action.',
  },
  'item.edit_details': {
    roles: MANAGER,
    denied: 'NOT_PROJECT_MANAGER',
    message: 'Only the Project Manager can edit item details.',
  },
  'item.delete': { roles: MANAGER, denied: 'NOT_PROJECT_MANAGER', message: 'Only the Project Manager can delete items.' },
  'item.restore': { roles: MANAGER, denied: 'NOT_PROJECT_MANAGER', message: 'Only the Project Manager can restore items.' },
  'item.comment': { roles: ALL, denied: 'FORBIDDEN', message: 'You cannot comment here.' },
  'item.link': { roles: ALL, denied: 'FORBIDDEN', message: 'You cannot link items here.' },
  'canvas.edit': { roles: ALL, denied: 'FORBIDDEN', message: 'You cannot edit this canvas.' },
  'workflow.edit_structure': { roles: ALL, denied: 'FORBIDDEN', message: 'You cannot edit this workflow.' },
  'workflow.edit_rules': {
    roles: LEADS,
    denied: 'LEAD_OR_MANAGER_REQUIRED',
    message: 'Only a Lead or the Manager can change workflow rules (approval, stage kinds, flags).',
  },
};

export interface ResourceRef {
  projectId: string;
  assigneeId?: string | null;
}

export function can(actor: Actor, action: Action, res: ResourceRef): boolean {
  const rule = MATRIX[action];
  const role = roleIn(actor, res.projectId);
  if (!role) return Boolean(rule.admin && actor.isAdmin);
  if (rule.roles.includes(role)) return true;
  if (rule.own && res.assigneeId != null && res.assigneeId === actor.id) return true;
  return Boolean(rule.admin && actor.isAdmin);
}

/**
 * Throws when the actor may not perform `action`.
 * Non-members get 404 (the resource's existence is not revealed); members get a specific 403.
 */
export function authorize(actor: Actor, action: Action, res: ResourceRef): void {
  if (can(actor, action, res)) return;
  const rule = MATRIX[action];
  const isMember = roleIn(actor, res.projectId) !== null;
  // Outsiders must not learn the project exists. Admins can see project metadata, so for them
  // a specific 403 is honest.
  if (!isMember && !actor.isAdmin) throw notFound();
  throw new AppError(rule.denied, rule.message);
}

/** The actions this actor may take on a resource; sent to the UI so it never guesses. */
export function permissionsFor(actor: Actor, res: ResourceRef): Action[] {
  return ACTIONS.filter((a) => can(actor, a, res));
}

export function requireAdmin(actor: Actor) {
  if (!actor.isAdmin) throw new AppError('ADMIN_REQUIRED', 'Only an Admin can do this.');
}
