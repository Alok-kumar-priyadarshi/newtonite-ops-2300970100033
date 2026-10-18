import { z } from 'zod';
import {
  CANVAS_ELEMENT_TYPES,
  DRAWING_ELEMENT_TYPES,
  ITEM_TYPES,
  ITEM_VIEWS,
  LIMITS,
  NOTE_KINDS,
  PROJECT_HEALTH,
  PROJECT_ROLES,
  STAGE_KINDS,
  WORKFLOW_TEMPLATES,
} from './constants';

/** Request schemas, used by the API for validation and by the web app for forms. */

const uuid = z.string().uuid();
const version = z.number().int().positive();
const reason = z.string().trim().min(1).max(1000);
const optionalReason = z.string().trim().max(1000).optional();
const isoDate = z.string().datetime({ offset: true });
const priority = z.number().int().min(1).max(4);

export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export const createItemSchema = z.object({
  projectId: uuid,
  type: z.enum(ITEM_TYPES),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10000).default(''),
  priority,
  dueAt: isoDate.nullable().optional(),
  assigneeId: uuid.nullable().optional(),
});

export const patchItemSchema = z
  .object({
    version,
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10000).optional(),
    type: z.enum(ITEM_TYPES).optional(),
    dueAt: isoDate.nullable().optional(),
    priority: priority.optional(),
    nextAction: z.string().trim().max(300).nullable().optional(),
    nextActionDueAt: isoDate.nullable().optional(),
    reason: optionalReason,
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version' && k !== 'reason'), {
    message: 'Nothing to update',
  });

export const versionOnlySchema = z.object({ version });
export const claimSchema = z.object({}).passthrough();

export const assignSchema = z.object({
  version,
  assigneeId: uuid.nullable(),
  reason,
});

export const transitionSchema = z.object({
  version,
  toStageId: uuid,
  reason: optionalReason,
});

export const deleteItemSchema = z.object({ version, reason });
export const restoreItemSchema = z.object({ reason });

export const noteSchema = z.object({
  kind: z.enum(NOTE_KINDS),
  body: z.string().trim().min(1).max(5000),
});

export const linkSchema = z.object({ blockerItemId: uuid });

const csv = <T extends [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const listItemsQuery = z.object({
  projectId: uuid.optional(),
  view: z.enum(ITEM_VIEWS).optional(),
  stageId: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(uuid))
    .optional(),
  type: csv(ITEM_TYPES as unknown as [string, ...string[]]).optional(),
  priority: z
    .string()
    .transform((s) => s.split(',').filter(Boolean).map(Number))
    .pipe(z.array(priority))
    .optional(),
  assigneeId: z.union([z.literal('me'), z.literal('none'), uuid]).optional(),
  due: z.enum(['overdue', 'today', 'week']).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['updated', 'priority', 'due']).default('updated'),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
  cursor: z.string().max(500).optional(),
});

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
  cursor: z.string().max(500).optional(),
});

export const activityQuery = pageQuery.extend({
  filter: z.enum(['all', 'notes', 'changes', 'decisions', 'approvals']).default('all'),
});

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,5}$/, 'Key must be 2–5 letters'),
  teamId: uuid,
  goal: z.string().trim().max(500).default(''),
  template: z.enum(WORKFLOW_TEMPLATES),
  managerId: uuid,
});

export const patchProjectSchema = z
  .object({
    version,
    name: z.string().trim().min(1).max(100).optional(),
    goal: z.string().trim().max(500).optional(),
    statusNote: z.string().trim().max(300).optional(),
    health: z.enum(PROJECT_HEALTH).optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: 'Nothing to update' });

export const addMemberSchema = z.object({ userId: uuid, role: z.enum(PROJECT_ROLES), reason });
export const changeRoleSchema = z.object({ role: z.enum(PROJECT_ROLES), reason });
export const removeMemberSchema = z.object({ reason });

const frame = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(120).max(5000),
  height: z.number().finite().min(80).max(5000),
});

export const addStageSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(60),
  kind: z.enum(STAGE_KINDS).default('active'),
  requiresApproval: z.boolean().default(false),
  frame,
  /** Insert the new stage on an existing connection A→B, creating A→new and new→B. */
  insertOnTransitionId: uuid.optional(),
  keepOriginalTransition: z.boolean().default(false),
});

export const patchStageSchema = z.object({
  version,
  name: z.string().trim().min(1).max(60).optional(),
  kind: z.enum(STAGE_KINDS).optional(),
  requiresApproval: z.boolean().optional(),
});

export const addTransitionSchema = z.object({
  id: uuid,
  fromStageId: uuid,
  toStageId: uuid,
  label: z.string().trim().max(40).nullable().optional(),
  requiresReason: z.boolean().default(false),
  leadOnly: z.boolean().default(false),
});

export const patchTransitionSchema = z.object({
  version,
  label: z.string().trim().max(40).nullable().optional(),
  requiresReason: z.boolean().optional(),
  leadOnly: z.boolean().optional(),
});

const props = z.record(z.any()).refine((p) => JSON.stringify(p).length <= 20_000, 'props too large');

export const createElementsSchema = z.object({
  elements: z
    .array(
      z.object({
        id: uuid,
        type: z.enum(DRAWING_ELEMENT_TYPES),
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().min(0).max(10000),
        height: z.number().finite().min(0).max(10000),
        zIndex: z.number().int().default(0),
        props: props.default({}),
      }),
    )
    .min(1)
    .max(LIMITS.canvasBatch),
});

export const patchElementsSchema = z.object({
  changes: z
    .array(
      z.object({
        id: uuid,
        version,
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        width: z.number().finite().min(0).max(10000).optional(),
        height: z.number().finite().min(0).max(10000).optional(),
        zIndex: z.number().int().optional(),
        props: props.optional(),
      }),
    )
    .min(1)
    .max(LIMITS.canvasBatch),
});

export const deleteElementsSchema = z.object({
  elements: z.array(z.object({ id: uuid, version })).min(1).max(LIMITS.canvasBatch),
});

export const restoreElementsSchema = z.object({
  ids: z.array(uuid).min(1).max(LIMITS.canvasBatch),
});

export const changesQuery = z.object({ since: isoDate });

export const heartbeatSchema = z.object({
  resourceType: z.enum(['item', 'canvas']),
  resourceId: uuid,
  selectedElementIds: z.array(uuid).max(200).default([]),
});

export const notificationsQuery = pageQuery.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
});

export const readAllSchema = z.object({ before: isoDate.optional() });

export const createTeamSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const createUserSchema = z.object({
  email: z.string().trim().email().max(200),
  fullName: z.string().trim().min(1).max(100),
  designation: z.string().trim().max(100).default(''),
  department: z.string().trim().max(100).default(''),
  employeeCode: z.string().trim().min(1).max(30),
  password: z.string().min(8).max(200),
  isAdmin: z.boolean().default(false),
});

export const peopleStatsQuery = z.object({
  projectId: uuid.optional(),
  period: z.enum(['month', 'quarter', 'all']).default('all'),
});

export const assistantChatSchema = z.object({
  /** The conversation so far (most recent last). Only the last 10 turns are used. */
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(40)
    .refine((m) => m[m.length - 1].role === 'user', 'The last message must be from the user'),
  /** The project the user is looking at, if any (used as the default scope). */
  projectId: uuid.optional(),
});

export { CANVAS_ELEMENT_TYPES };
