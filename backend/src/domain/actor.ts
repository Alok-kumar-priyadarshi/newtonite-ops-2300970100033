import type { ProjectRole } from '@nops/shared';

/** The authenticated caller. Roles are loaded from the database on every request. */
export interface Actor {
  id: string;
  orgId: string;
  fullName: string;
  isAdmin: boolean;
  /** projectId → current role */
  roles: Map<string, ProjectRole>;
}

export function roleIn(actor: Actor, projectId: string): ProjectRole | null {
  return actor.roles.get(projectId) ?? null;
}

/** The role recorded on activity events: what the actor was *at that moment*. */
export function actorRoleLabel(actor: Actor | null, projectId: string): string {
  if (!actor) return 'system';
  return roleIn(actor, projectId) ?? (actor.isAdmin ? 'admin' : 'none');
}
