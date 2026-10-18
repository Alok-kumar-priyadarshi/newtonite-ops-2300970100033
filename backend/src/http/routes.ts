import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as S from '@nops/shared';
import { z } from 'zod';
import { config } from '../config';
import { sql } from '../db';
import { AppError } from '../domain/errors';
import { cleanupExpired } from '../outbox/maintenance';
import { processOutboxBatch } from '../outbox/process';
import * as admin from '../services/admin';
import { assistantEnabled, runAssistant } from '../services/assistant';
import * as canvas from '../services/canvas';
import { getDashboard, listItems } from '../services/item-list';
import * as items from '../services/items';
import * as notifications from '../services/notifications';
import * as people from '../services/people';
import { heartbeat } from '../services/presence';
import * as projects from '../services/projects';
import { initials } from '../services/users';
import * as workflow from '../services/workflow';
import { authenticate, clearSession, issueSession, loadActor } from './auth';
import { idempotent, ok, parse, read, write } from './handlers';

const id = (v: unknown) => parse(z.string().uuid(), v);
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// ------------------------------------------------------------------ public

export const publicRouter = Router();

publicRouter.get('/health', async (_req, res) => {
  try {
    await sql`select 1`;
    res.json({ ok: true, db: 'up' });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});

publicRouter.post('/auth/login', async (req, res) => {
  const { email, password } = parse(S.loginSchema, req.body);
  const [user] = await sql<{ id: string; password_hash: string; is_active: boolean }[]>`
    select id, password_hash, is_active from users where lower(email) = lower(${email})`;
  // Same message for unknown email and wrong password; compare even when the user is missing.
  const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !valid || !user.is_active) throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
  issueSession(res, user.id);
  res.json(await me(user.id));
});

publicRouter.post('/auth/logout', (_req, res) => {
  clearSession(res);
  res.status(204).end();
});

publicRouter.get('/auth/demo-users', async (_req, res) => {
  if (!config.DEMO_MODE) throw new AppError('NOT_FOUND', 'Not found.');
  const rows = await sql<{ email: string; full_name: string; designation: string; is_admin: boolean; roles: string | null }[]>`
    select u.email, u.full_name, u.designation, u.is_admin,
      string_agg(initcap(m.role::text) || ' · ' || p.key, ', ' order by p.key) as roles
    from users u
    left join project_members m on m.user_id = u.id and m.valid_to is null
    left join projects p on p.id = m.project_id
    where u.is_active
    group by u.id order by u.is_admin desc, u.full_name`;
  res.json(
    rows.map((r) => ({
      email: r.email,
      fullName: r.full_name,
      designation: r.designation,
      roles: [r.is_admin ? 'Admin' : null, r.roles].filter(Boolean).join(', ') || 'No projects',
    })),
  );
});

/** Called by the external scheduler on serverless hosting (docs/12-deployment.md). */
publicRouter.post('/internal/outbox/run', async (req, res) => {
  if (req.get('x-cron-secret') !== config.CRON_SECRET) throw new AppError('NOT_FOUND', 'Not found.');
  let processed = 0;
  for (let i = 0; i < 5; i++) {
    const n = await processOutboxBatch(50);
    processed += n;
    if (n === 0) break;
  }
  res.json({ processed, removed: await cleanupExpired() });
});

async function me(userId: string): Promise<S.Me> {
  const [u] = await sql<
    { id: string; full_name: string; avatar_color: string; email: string; designation: string; department: string; is_admin: boolean }[]
  >`select id, full_name, avatar_color, email, designation, department, is_admin from users where id = ${userId}`;
  const memberships = await sql<{ project_id: string; key: string; name: string; team: string; role: S.ProjectRole }[]>`
    select p.id as project_id, p.key, p.name, t.name as team, m.role
    from project_members m join projects p on p.id = m.project_id join teams t on t.id = p.team_id
    where m.user_id = ${userId} and m.valid_to is null order by t.name, p.name`;
  return {
    user: {
      id: u.id,
      fullName: u.full_name,
      initials: initials(u.full_name),
      avatarColor: u.avatar_color,
      email: u.email,
      designation: u.designation,
      department: u.department,
      isAdmin: u.is_admin,
    },
    memberships: memberships.map((m) => ({
      projectId: m.project_id,
      projectKey: m.key,
      projectName: m.name,
      teamName: m.team,
      role: m.role,
    })),
  };
}

// ------------------------------------------------------------------ authenticated

export const apiRouter = Router();
apiRouter.use(authenticate);

apiRouter.get('/me', read((_req, actor) => me(actor.id)));
apiRouter.get('/dashboard', read((_req, actor) => getDashboard(actor)));
apiRouter.get('/directory', read((_req, actor) => admin.directory(actor)));

// Items -------------------------------------------------------------
apiRouter.get('/items', read((req, actor) => listItems(actor, parse(S.listItemsQuery, req.query))));

apiRouter.post(
  '/items',
  idempotent(async (tx, req, actor) => ok(await items.createItem(tx, actor, parse(S.createItemSchema, req.body)), 201)),
);
apiRouter.get('/items/:itemId', read((req, actor) => items.getItem(actor, id(req.params.itemId))));
apiRouter.patch(
  '/items/:itemId',
  write(async (tx, req, actor) => ok(await items.patchItem(tx, actor, id(req.params.itemId), parse(S.patchItemSchema, req.body)))),
);
apiRouter.post(
  '/items/:itemId/claim',
  idempotent(async (tx, req, actor) => ok(await items.claimItem(tx, actor, id(req.params.itemId)))),
);
apiRouter.post(
  '/items/:itemId/release',
  idempotent(async (tx, req, actor) =>
    ok(await items.releaseItem(tx, actor, id(req.params.itemId), parse(S.versionOnlySchema, req.body))),
  ),
);
apiRouter.post(
  '/items/:itemId/assign',
  idempotent(async (tx, req, actor) =>
    ok(await items.assignItem(tx, actor, id(req.params.itemId), parse(S.assignSchema, req.body))),
  ),
);
apiRouter.post(
  '/items/:itemId/transition',
  idempotent(async (tx, req, actor) =>
    ok(await items.transitionItem(tx, actor, id(req.params.itemId), parse(S.transitionSchema, req.body))),
  ),
);
apiRouter.delete(
  '/items/:itemId',
  idempotent(async (tx, req, actor) =>
    ok(await items.deleteItem(tx, actor, id(req.params.itemId), parse(S.deleteItemSchema, req.body))),
  ),
);
apiRouter.post(
  '/items/:itemId/restore',
  idempotent(async (tx, req, actor) =>
    ok(await items.restoreItem(tx, actor, id(req.params.itemId), parse(S.restoreItemSchema, req.body))),
  ),
);
apiRouter.get(
  '/items/:itemId/activity',
  read((req, actor) => items.listItemActivity(actor, id(req.params.itemId), parse(S.activityQuery, req.query))),
);
apiRouter.post(
  '/items/:itemId/notes',
  idempotent(async (tx, req, actor) => ok(await items.addNote(tx, actor, id(req.params.itemId), parse(S.noteSchema, req.body)), 201)),
);
apiRouter.post(
  '/items/:itemId/links',
  write(async (tx, req, actor) => ok(await items.addLink(tx, actor, id(req.params.itemId), parse(S.linkSchema, req.body)), 201)),
);
apiRouter.delete(
  '/items/:itemId/links/:blockerItemId',
  write(async (tx, req, actor) => {
    await items.removeLink(tx, actor, id(req.params.itemId), id(req.params.blockerItemId));
    return ok(null, 204);
  }),
);

// Projects & members -------------------------------------------------
apiRouter.get('/projects', read((_req, actor) => projects.listProjects(actor)));
apiRouter.post(
  '/projects',
  idempotent(async (tx, req, actor) => ok(await projects.createProject(tx, actor, parse(S.createProjectSchema, req.body)), 201)),
);
apiRouter.get('/projects/:projectId', read((req, actor) => projects.getProject(sql, actor, id(req.params.projectId))));
apiRouter.patch(
  '/projects/:projectId',
  write(async (tx, req, actor) =>
    ok(await projects.patchProject(tx, actor, id(req.params.projectId), parse(S.patchProjectSchema, req.body))),
  ),
);
apiRouter.get('/projects/:projectId/members', read((req, actor) => projects.listMembers(actor, id(req.params.projectId))));
apiRouter.post(
  '/projects/:projectId/members',
  idempotent(async (tx, req, actor) =>
    ok(await projects.addMember(tx, actor, id(req.params.projectId), parse(S.addMemberSchema, req.body)), 201),
  ),
);
apiRouter.patch(
  '/projects/:projectId/members/:userId',
  idempotent(async (tx, req, actor) =>
    ok(await projects.changeRole(tx, actor, id(req.params.projectId), id(req.params.userId), parse(S.changeRoleSchema, req.body))),
  ),
);
apiRouter.delete(
  '/projects/:projectId/members/:userId',
  idempotent(async (tx, req, actor) => {
    await projects.removeMember(tx, actor, id(req.params.projectId), id(req.params.userId), parse(S.removeMemberSchema, req.body));
    return ok(null, 204);
  }),
);
apiRouter.get(
  '/projects/:projectId/items/deleted',
  read((req, actor) => items.listDeletedItems(actor, id(req.params.projectId), parse(S.pageQuery, req.query))),
);

// Workflow -----------------------------------------------------------
apiRouter.get(
  '/projects/:projectId/workflow',
  read(async (req, actor) => {
    const projectId = id(req.params.projectId);
    projects.requireMember(actor, projectId);
    return workflow.loadWorkflow(sql, projectId);
  }),
);
apiRouter.post(
  '/projects/:projectId/workflow/stages',
  write(async (tx, req, actor) => {
    const projectId = id(req.params.projectId);
    projects.requireMember(actor, projectId);
    return ok(await workflow.addStage(tx, actor, projectId, parse(S.addStageSchema, req.body)), 201);
  }),
);
apiRouter.patch(
  '/projects/:projectId/workflow/stages/:stageId',
  write(async (tx, req, actor) => {
    const projectId = id(req.params.projectId);
    projects.requireMember(actor, projectId);
    return ok(await workflow.patchStage(tx, actor, projectId, id(req.params.stageId), parse(S.patchStageSchema, req.body)));
  }),
);
apiRouter.delete(
  '/projects/:projectId/workflow/stages/:stageId',
  write(async (tx, req, actor) => {
    const projectId = id(req.params.projectId);
    projects.requireMember(actor, projectId);
    return ok(await workflow.deleteStage(tx, actor, projectId, id(req.params.stageId)));
  }),
);
apiRouter.post(
  '/projects/:projectId/workflow/transitions',
  write(async (tx, req, actor) => {
    const projectId = id(req.params.projectId);
    projects.requireMember(actor, projectId);
    return ok(await workflow.addTransition(tx, actor, projectId, parse(S.addTransitionSchema, req.body)), 201);
  }),
);
apiRouter.patch(
  '/projects/:projectId/workflow/transitions/:transitionId',
  write(async (tx, req, actor) => {
    const projectId = id(req.params.projectId);
    projects.requireMember(actor, projectId);
    return ok(
      await workflow.patchTransition(tx, actor, projectId, id(req.params.transitionId), parse(S.patchTransitionSchema, req.body)),
    );
  }),
);
apiRouter.delete(
  '/projects/:projectId/workflow/transitions/:transitionId',
  write(async (tx, req, actor) => {
    const projectId = id(req.params.projectId);
    projects.requireMember(actor, projectId);
    return ok(await workflow.deleteTransition(tx, actor, projectId, id(req.params.transitionId)));
  }),
);

// Canvas -------------------------------------------------------------
apiRouter.get('/projects/:projectId/canvas', read((req, actor) => canvas.getCanvas(actor, id(req.params.projectId))));
apiRouter.get(
  '/projects/:projectId/changes',
  read((req, actor) => canvas.getChanges(actor, id(req.params.projectId), parse(S.changesQuery, req.query).since)),
);
apiRouter.get(
  '/projects/:projectId/stages/:stageId/items',
  read((req, actor) =>
    canvas.listStageItems(actor, id(req.params.projectId), id(req.params.stageId), parse(S.pageQuery, req.query)),
  ),
);
apiRouter.post(
  '/projects/:projectId/canvas/elements',
  write(async (tx, req, actor) =>
    ok(await canvas.createElements(tx, actor, id(req.params.projectId), parse(S.createElementsSchema, req.body).elements), 201),
  ),
);
apiRouter.patch(
  '/projects/:projectId/canvas/elements',
  write(async (tx, req, actor) =>
    ok(await canvas.patchElements(tx, actor, id(req.params.projectId), parse(S.patchElementsSchema, req.body).changes)),
  ),
);
apiRouter.post(
  '/projects/:projectId/canvas/elements/delete',
  write(async (tx, req, actor) => {
    await canvas.deleteElements(tx, actor, id(req.params.projectId), parse(S.deleteElementsSchema, req.body).elements);
    return ok({ deleted: true });
  }),
);
apiRouter.post(
  '/projects/:projectId/canvas/elements/restore',
  write(async (tx, req, actor) =>
    ok(await canvas.restoreElements(tx, actor, id(req.params.projectId), parse(S.restoreElementsSchema, req.body).ids)),
  ),
);

// Presence & notifications -------------------------------------------
apiRouter.post('/presence/heartbeat', read((req, actor) => heartbeat(actor, parse(S.heartbeatSchema, req.body))));
apiRouter.get('/notifications', read((req, actor) => notifications.listNotifications(actor, parse(S.notificationsQuery, req.query))));
apiRouter.get('/notifications/unread-count', read((_req, actor) => notifications.unreadCount(actor)));
apiRouter.post('/notifications/read-all', async (req, res) => {
  await notifications.markAllRead(req.actor!, parse(S.readAllSchema, req.body).before);
  res.status(204).end();
});
apiRouter.post('/notifications/:id/read', async (req, res) => {
  await notifications.markRead(req.actor!, parse(z.string().regex(/^\d+$/), req.params.id));
  res.status(204).end();
});

// People -------------------------------------------------------------
apiRouter.get('/people/:userId', read((req, actor) => people.getPerson(actor, id(req.params.userId))));
apiRouter.get('/people/:userId/history', read((req, actor) => people.getRoleHistory(actor, id(req.params.userId))));
apiRouter.get(
  '/people/:userId/stats',
  read((req, actor) => people.getStats(actor, id(req.params.userId), parse(S.peopleStatsQuery, req.query))),
);
apiRouter.get(
  '/people/:userId/activity',
  read((req, actor) => people.getPersonActivity(actor, id(req.params.userId), parse(S.activityQuery, req.query))),
);

// Assistant ----------------------------------------------------------
apiRouter.get('/assistant/status', read(async () => ({ enabled: assistantEnabled(), model: config.GROQ_MODEL })));
apiRouter.post('/assistant/chat', read((req, actor) => runAssistant(actor, parse(S.assistantChatSchema, req.body))));

// Admin --------------------------------------------------------------
apiRouter.get('/teams', read((_req, actor) => admin.listTeams(actor)));
apiRouter.post(
  '/teams',
  idempotent(async (tx, req, actor) => ok(await admin.createTeam(tx, actor, parse(S.createTeamSchema, req.body)), 201)),
);
apiRouter.get('/admin/users', read((_req, actor) => admin.listUsers(actor)));
apiRouter.post(
  '/admin/users',
  idempotent(async (tx, req, actor) => ok(await admin.createUser(tx, actor, parse(S.createUserSchema, req.body)), 201)),
);
apiRouter.post(
  '/admin/users/:userId/active',
  write(async (tx, req, actor) => {
    await admin.setUserActive(tx, actor, id(req.params.userId), parse(z.object({ active: z.boolean() }), req.body).active);
    return ok(null, 204);
  }),
);
apiRouter.get(
  '/admin/jobs',
  read((req, actor) =>
    admin.listJobs(actor, parse(S.pageQuery.extend({ status: z.enum(['failed', 'pending', 'processing', 'done']).default('failed') }), req.query)),
  ),
);
apiRouter.post(
  '/admin/jobs/:jobId/retry',
  write(async (tx, req, actor) => {
    await admin.retryJob(tx, actor, parse(z.string().regex(/^\d+$/), req.params.jobId));
    return ok(null, 204);
  }),
);

export { loadActor };
