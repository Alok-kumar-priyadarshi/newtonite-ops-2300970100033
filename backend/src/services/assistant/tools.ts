import { type ActivityEvent, ITEM_VIEWS, type ItemSummary } from '@nops/shared';
import { sql } from '../../db';
import type { Actor } from '../../domain/actor';
import { describeEvent } from '../../domain/describe';
import { getDashboard, listItems } from '../item-list';
import { getItem, listItemActivity } from '../items';
import { getPerson, getPersonActivity } from '../people';
import { listMembers, listProjects } from '../projects';

/**
 * Read-only tools the assistant can call. Every tool runs as the signed-in user through the same
 * services the app uses, so the assistant can never see more than that user can (docs/06). Tools
 * return compact JSON: short text, relative times, and at most 20 rows.
 */

export interface ToolContext {
  actor: Actor;
  /** Project the user is looking at, used when the model doesn't name one. */
  projectId?: string;
  /** Items seen in tool results, so the answer's item keys can be linked. */
  seenItems: Map<string, { id: string; key: string; title: string }>;
}

const MAX_ROWS = 20;

export function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const future = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60_000);
  const text =
    mins < 1 ? 'just now' : mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  return mins < 1 ? text : future ? `in ${text}` : `${text} ago`;
}

const remember = (ctx: ToolContext, i: { id: string; key: string; title: string }) => ctx.seenItems.set(i.key, i);

function compactItem(ctx: ToolContext, i: ItemSummary) {
  remember(ctx, i);
  return {
    key: i.key,
    title: i.title,
    type: i.type,
    stage: i.stage.name,
    priority: `P${i.priority}`,
    owner: i.assignee?.fullName ?? 'unassigned',
    due: i.dueAt ? `${i.dueAt.slice(0, 10)} (${ago(i.dueAt)})` : null,
    overdue: i.isOverdue || undefined,
    blocked: i.isBlocked || undefined,
    awaitingApproval: i.awaitingApproval || undefined,
    nextAction: i.nextAction ?? undefined,
    updated: ago(i.updatedAt),
  };
}

function compactEvent(ctx: ToolContext, e: ActivityEvent) {
  if (e.item) remember(ctx, e.item);
  const text =
    e.type === 'note.added'
      ? `posted a ${e.data.kind}: "${String(e.data.body).slice(0, 200)}"`
      : describeEvent(e.type, e.data).replace('this item', e.item?.key ?? 'an item');
  return {
    when: ago(e.createdAt),
    at: e.createdAt,
    who: e.actor?.fullName ?? 'system',
    asRole: e.actorRole,
    what: text,
    reason: e.data.reason ?? undefined,
    item: e.item ? `${e.item.key} ${e.item.title}` : undefined,
    project: e.project?.key,
  };
}

// ------------------------------------------------------------------ name resolution (scoped)

const myProjectIds = (actor: Actor) => [...actor.roles.keys()];
const likePattern = (s: string) => `%${s.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function resolveProject(ctx: ToolContext, keyOrName?: string): Promise<string | undefined> {
  if (!keyOrName) return ctx.projectId;
  const ids = myProjectIds(ctx.actor);
  if (ids.length === 0) throw new Error('You are not a member of any project.');
  const rows = await sql<{ id: string }[]>`
    select id from projects
    where id in ${sql(ids)} and (key = upper(${keyOrName.trim()}) or name ilike ${likePattern(keyOrName)})
    limit 2`;
  if (rows.length === 0) throw new Error(`No project "${keyOrName}" among your projects.`);
  return rows[0].id;
}

/** People who share at least one project with the user (or everyone, for Admins). */
async function resolvePerson(ctx: ToolContext, name: string) {
  const ids = myProjectIds(ctx.actor);
  const rows = await sql<{ id: string; full_name: string; designation: string }[]>`
    select distinct u.id, u.full_name, u.designation from users u
    ${ctx.actor.isAdmin ? sql`` : sql`join project_members m on m.user_id = u.id and m.valid_to is null`}
    where u.org_id = ${ctx.actor.orgId} and u.full_name ilike ${likePattern(name)}
      ${ctx.actor.isAdmin ? sql`` : ids.length ? sql`and m.project_id in ${sql(ids)}` : sql`and false`}
    order by u.full_name limit 5`;
  if (rows.length === 0) throw new Error(`No one called "${name}" in your projects.`);
  if (rows.length > 1) {
    const exact = rows.find((r) => r.full_name.toLowerCase() === name.trim().toLowerCase());
    if (!exact) return { ambiguous: rows.map((r) => `${r.full_name} (${r.designation})`) };
    return { id: exact.id, name: exact.full_name };
  }
  return { id: rows[0].id, name: rows[0].full_name };
}

async function resolveStages(projectId: string | undefined, actor: Actor, stageName: string) {
  const ids = projectId ? [projectId] : myProjectIds(actor);
  if (ids.length === 0) return [];
  const rows = await sql<{ id: string }[]>`
    select id from workflow_stages
    where project_id in ${sql(ids)} and deleted_at is null and name ilike ${likePattern(stageName)}`;
  if (rows.length === 0) throw new Error(`No stage called "${stageName}".`);
  return rows.map((r) => r.id);
}

// ------------------------------------------------------------------ tools

type Args = Record<string, any>;
interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  label: (a: Args) => string;
  run: (ctx: ToolContext, a: Args) => Promise<unknown>;
}

export const TOOLS: Record<string, Tool> = {
  search_items: {
    description:
      'Search and filter work items the user can see. Use for questions like "what is X working on", "P1 items in review", "overdue payments". Returns up to 20 items plus the total count.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key (e.g. PAY) or name. Omit for the current project, or all projects if there is none.' },
        allProjects: { type: 'boolean', description: 'Search all of the user\'s projects instead of the current one.' },
        text: { type: 'string', description: 'Words to search in titles and descriptions, or an item key like PAY-42.' },
        owner: { type: 'string', description: 'Person name, "me", or "unassigned".' },
        stage: { type: 'string', description: 'Stage name, e.g. "In Progress" or "Awaiting Approval".' },
        priorities: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 4 }, description: '1 = P1 (highest) … 4 = P4.' },
        view: { type: 'string', enum: [...ITEM_VIEWS], description: 'Predefined views from the dashboard.' },
        sort: { type: 'string', enum: ['updated', 'priority', 'due'], description: 'Default: most recently updated first.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
      },
    },
    label: (a) => {
      const owner = String(a.owner ?? '').trim().toLowerCase();
      const who = !a.owner ? '' : owner === 'unassigned' || owner === 'none' ? ' with no owner' : owner === 'me' ? ' owned by you' : ` owned by ${a.owner}`;
      const prio = Array.isArray(a.priorities) && a.priorities.length ? ` (${a.priorities.map((p: number) => `P${p}`).join(', ')})` : '';
      return `Searched items${who}${prio}${a.stage ? ` in ${a.stage}` : ''}${a.text ? ` for “${a.text}”` : ''}`;
    },
    run: async (ctx, a) => {
      const projectId = a.allProjects ? undefined : await resolveProject(ctx, a.project);
      let assigneeId: string | undefined;
      if (a.owner) {
        const o = String(a.owner).trim().toLowerCase();
        if (o === 'me') assigneeId = 'me';
        else if (o === 'unassigned' || o === 'none') assigneeId = 'none';
        else {
          const p = await resolvePerson(ctx, a.owner);
          if ('ambiguous' in p) return { ambiguousOwner: p.ambiguous };
          assigneeId = p.id;
        }
      }
      const stageId = a.stage ? await resolveStages(projectId, ctx.actor, a.stage) : undefined;
      const page = await listItems(ctx.actor, {
        projectId,
        q: a.text || undefined,
        assigneeId,
        stageId,
        priority: Array.isArray(a.priorities) ? a.priorities.filter((p: number) => p >= 1 && p <= 4) : undefined,
        view: ITEM_VIEWS.includes(a.view) ? a.view : undefined,
        sort: ['updated', 'priority', 'due'].includes(a.sort) ? a.sort : 'updated',
        limit: Math.min(Math.max(Number(a.limit) || 10, 1), MAX_ROWS),
      });
      return { total: page.totalIsCapped ? `${page.total}+` : page.total, items: page.items.map((i) => compactItem(ctx, i)) };
    },
  },

  get_item: {
    description: 'Full details and the latest history of one item, by its key (e.g. PAY-42).',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    label: (a) => `Opened ${a.key}`,
    run: async (ctx, a) => {
      const found = await listItems(ctx.actor, { q: String(a.key).trim(), sort: 'updated', limit: 1 });
      const hit = found.items[0];
      if (!hit || hit.key.toUpperCase() !== String(a.key).trim().toUpperCase()) throw new Error(`Item ${a.key} not found.`);
      const [detail, history] = await Promise.all([
        getItem(ctx.actor, hit.id),
        listItemActivity(ctx.actor, hit.id, { filter: 'all', limit: 10 }),
      ]);
      return {
        ...compactItem(ctx, detail),
        description: detail.description.slice(0, 600),
        createdBy: detail.createdBy.fullName,
        created: ago(detail.createdAt),
        blockedBy: detail.blockers.map((b) => `${b.key} (${b.stage.name})`),
        possibleMovesForUser: detail.allowedTransitions.map((t) => t.toStageName),
        recentHistory: history.items.map((e) => compactEvent(ctx, e)),
      };
    },
  },

  get_person_activity: {
    description:
      'What a person has been doing: their latest actions (moves, approvals, notes, claims), current projects and roles, and open item counts. Use for "what is X doing / last working on".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full or partial name, or "me".' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: 'How many recent actions (default 10).' },
      },
      required: ['name'],
    },
    label: (a) => `Looked up ${a.name}’s recent activity`,
    run: async (ctx, a) => {
      const person = String(a.name).trim().toLowerCase() === 'me' ? { id: ctx.actor.id, name: ctx.actor.fullName } : await resolvePerson(ctx, a.name);
      if ('ambiguous' in person) return { ambiguousName: person.ambiguous };
      const [profile, activity] = await Promise.all([
        getPerson(ctx.actor, person.id),
        getPersonActivity(ctx.actor, person.id, { filter: 'all', limit: Math.min(Math.max(Number(a.limit) || 10, 1), MAX_ROWS) }),
      ]);
      return {
        person: `${profile.user.fullName}, ${profile.user.designation}`,
        projects: profile.currentProjects.map((p) => `${p.project.key}: ${p.role}, ${p.openItems} open items`),
        recentActions: activity.items.map((e) => compactEvent(ctx, e)),
        note: 'Only actions in projects the user shares with this person are included.',
      };
    },
  },

  list_projects: {
    description: 'The user\'s projects with health, status, their role and counts (open, awaiting approval, blocked, overdue).',
    parameters: { type: 'object', properties: {} },
    label: () => 'Listed projects',
    run: async (ctx) =>
      (await listProjects(ctx.actor)).map((p) => ({
        key: p.key,
        name: p.name,
        health: p.health,
        status: p.statusNote,
        myRole: p.myRole,
        manager: p.manager?.fullName,
        counts: p.counts,
      })),
  },

  list_members: {
    description: 'People in a project and their roles (Manager, Lead, Member), job titles and open item counts.',
    parameters: { type: 'object', properties: { project: { type: 'string', description: 'Project key or name; omit for the current project.' } } },
    label: (a) => `Listed members${a.project ? ` of ${a.project}` : ''}`,
    run: async (ctx, a) => {
      const projectId = await resolveProject(ctx, a.project);
      if (!projectId) throw new Error('Which project? Give a project key or name.');
      return (await listMembers(ctx.actor, projectId)).map((m) => ({
        name: m.user.fullName,
        jobTitle: m.user.designation,
        role: m.role,
        openItems: m.user.openItemCount,
      }));
    },
  },

  get_my_dashboard: {
    description: 'The user\'s own "needs attention" counts (assigned to me, awaiting my approval, overdue, blocked, forgotten…) and items due soon.',
    parameters: { type: 'object', properties: {} },
    label: () => 'Checked your dashboard',
    run: async (ctx) => {
      const d = await getDashboard(ctx.actor);
      return { counts: d.counts, dueSoon: d.dueSoon.map((i) => compactItem(ctx, i)) };
    },
  },
};

/** Tool declarations in the OpenAI/Groq function-calling format. */
export const TOOL_DECLARATIONS = Object.entries(TOOLS).map(([name, t]) => ({
  type: 'function' as const,
  function: { name, description: t.description, parameters: t.parameters },
}));
