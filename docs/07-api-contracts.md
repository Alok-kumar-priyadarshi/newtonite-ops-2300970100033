# 7. API Contracts

## 7.1 Conventions

| Topic | Rule |
|---|---|
| Base path | `/api` |
| Format | JSON, `camelCase` fields, ISO-8601 UTC timestamps |
| Auth | Session cookie `nops_session` (httpOnly) |
| CSRF | Non-GET requests require `X-Requested-With: newtonite-ops` |
| CORS | None by default (the frontend uses `/api` on its own domain). With `CORS_ORIGINS`, only the listed origins may call, with credentials |
| Idempotency | Endpoints marked **🔑** require `Idempotency-Key: <uuid>` (428 if missing). Replays return the stored response with `Idempotent-Replayed: true` |
| Versions | Endpoints marked **🔢** require `version` (the version the client last saw) |
| Validation | zod schemas from `shared`; shared by client and server |
| Pagination | `?limit=` (default 50, max 100) and `?cursor=`; response `{ items, nextCursor }`; `nextCursor: null` = last page. Cursors are opaque base64 of the last row's sort key + id |
| IDs | UUIDs in paths. Items also expose `key` (`PAY-4790`) |
| Request id | Every response has `X-Request-Id`; it is also in error bodies and logs |

### Error envelope

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "This item was changed by Ravi Sharma 30 seconds ago.",
    "details": { "current": { "…": "…" }, "changes": [] },
    "requestId": "b6f1…"
  }
}
```

### Error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body/query fails schema; `details.issues[]` |
| 401 | `UNAUTHENTICATED` | No/expired session, or user inactive |
| 401 | `INVALID_CREDENTIALS` | Login failed (same message for unknown email and wrong password) |
| 403 | `CSRF_HEADER_MISSING` | Missing `X-Requested-With` on a write |
| 403 | `NOT_PROJECT_MANAGER` | Manager-only action |
| 403 | `LEAD_OR_MANAGER_REQUIRED` | Lead/Manager-only action |
| 403 | `NOT_ASSIGNEE` | Member acting on an item not assigned to them |
| 403 | `APPROVAL_ROLE_REQUIRED` | Non-Lead entering a protected stage |
| 403 | `SELF_APPROVAL_FORBIDDEN` | Approver is creator or assignee |
| 403 | `ADMIN_REQUIRED` | Admin-only action |
| 403 | `FORBIDDEN` | Generic refusal (rare; most refusals use a specific code above) |
| 404 | `NOT_FOUND` | Missing, or not visible to the caller |
| 409 | `VERSION_CONFLICT` | Stale `version`; `details.current`, `details.changes` |
| 409 | `ALREADY_CLAIMED` | `details.assignee`, `details.claimedAt` |
| 409 | `BLOCKED_BY_OPEN_ITEMS` | `details.blockers[]` |
| 409 | `ELEMENT_CONFLICT` | Canvas batch; `details.conflicts[]` |
| 409 | `STAGE_NOT_EMPTY` | `details.itemCount` |
| 409 | `STAGE_NAME_TAKEN` | |
| 409 | `LAST_MANAGER` | Removing/demoting the only Manager |
| 409 | `ALREADY_MEMBER` | Adding someone who is already a member |
| 409 | `KEY_TAKEN` | Project key, team name, email or employee code already used |
| 410 | `ITEM_DELETED` | `details.deletedBy`, `details.deletedAt`, `details.reason` |
| 422 | `INVALID_TRANSITION` | No such connection from the current stage |
| 422 | `INVALID_ASSIGNEE` | Assignee is not a current member of the project |
| 422 | `REASON_REQUIRED` | |
| 422 | `WORKFLOW_INVALID` | `details.reason`: `START_STAGE` · `APPROVAL_BYPASS` (unreachable stages and dead ends are warnings in `workflow.warnings`, see [04](04-workflow-rules.md)) |
| 422 | `DEPENDENCY_CYCLE` | |
| 422 | `CANVAS_LIMIT_REACHED` | > 2,000 elements |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body over 256 KB |
| 428 | `IDEMPOTENCY_KEY_REQUIRED` | |
| 429 | `RATE_LIMITED` | Assistant: more than 15 questions a minute, or the AI provider is busy |
| 500 | `INTERNAL` | Unexpected; details logged with request id |
| 502 | `ASSISTANT_FAILED` | AI provider error, timeout or rejected API key |
| 503 | `SERVICE_UNAVAILABLE` | Database unreachable or a query timed out; `Retry-After` header |
| 503 | `ASSISTANT_DISABLED` | `GROQ_API_KEY` not configured |

## 7.2 Shared types

```ts
type UserMini   = { id: string; fullName: string; initials: string; avatarColor: string };
type WorkerMini = UserMini & { designation: string; projectRole: 'manager'|'lead'|'member'; openItemCount: number };
type Stage      = { id: string; name: string; kind: 'start'|'active'|'done'; requiresApproval: boolean; version: number };
type Transition = { id: string; fromStageId: string; toStageId: string; label: string|null;
                    requiresReason: boolean; leadOnly: boolean; version: number };

type ItemSummary = {
  id: string; key: string; number: number; projectId: string; projectKey: string;
  type: 'incident'|'customer_issue'|'payment'|'compliance'|'task';
  title: string; priority: 1|2|3|4;
  stage: { id: string; name: string; kind: Stage['kind'] };
  assignee: WorkerMini | null; createdBy: UserMini;
  dueAt: string|null; nextAction: string|null; nextActionDueAt: string|null;
  isBlocked: boolean; awaitingApproval: boolean; isOverdue: boolean;
  version: number; createdAt: string; updatedAt: string; lastActivityAt: string;
  deleted?: true;                      // only in the changes feed
};

type ItemCard = ItemSummary & {          // canvas
  descriptionExcerpt: string;            // first 140 chars: the "why"
  lastChange: { actor: UserMini | null; summary: string; at: string } | null;
  noteCount: number;
};

type ItemDetail = ItemSummary & {
  description: string;
  blockers: ItemSummary[]; blocking: ItemSummary[];
  permissions: string[];
  allowedTransitions: { transitionId: string; toStageId: string; toStageName: string; label: string|null;
                        requiresReason: boolean; isApproval: boolean }[];
  blockedTransitions: { transitionId: string; toStageId: string; toStageName: string; label: string|null;
                        code: string; reason: string }[];   // moves refused for this user, and why
  viewers: UserMini[];                   // presence
  deletedBy?: UserMini | null; deleteReason?: string | null;   // Managers viewing a deleted item
};

type ProjectSummary = {
  id; key; name; team: {id, name}; goal; statusNote; health; myRole: Role|null;
  manager: UserMini|null; leads: UserMini[];
  counts: { open; awaitingApproval; blocked; overdue };
  version; updatedAt; updatedBy: UserMini|null;
};
type ProjectDetail = ProjectSummary & { permissions: string[]; workflow: { version, stages, transitions, warnings } };

type ActivityEvent = {
  id: string; type: string; actor: UserMini | null; actorRole: string;
  data: Record<string, unknown>; itemVersion: number|null; createdAt: string;
};

type CanvasElement = {
  id: string; type: 'project_node'|'stage_frame'|'rectangle'|'ellipse'|'diamond'|'text'|'sticky'|'arrow'|'freehand';
  stageId: string|null; x: number; y: number; width: number; height: number; zIndex: number;
  props: Record<string, unknown>; version: number; updatedBy: UserMini; updatedAt: string; deleted?: true;
};
```

## 7.3 Auth & session

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /api/auth/login` | `{email, password}` | 200 same body as `GET /api/me` + Set-Cookie | 400, 401 `INVALID_CREDENTIALS` |
| `POST /api/auth/logout` | – | 204, cookie cleared | |
| `GET /api/me` | – | 200 `{user:{…, designation, isAdmin}, memberships:[{projectId, projectKey, projectName, teamName, role}]}` | 401 |
| `GET /api/auth/demo-users` | – | 200 `[{email, fullName, designation, roles}]` — only when `DEMO_MODE=true`, else 404 | |

## 7.4 Dashboard

`GET /api/dashboard` → 200

```json
{
  "counts": { "assignedToMe": 12, "nextActionsDue": 4, "overdue": 1, "awaitingMyApproval": 3,
              "unassignedUrgent": 5, "blocked": 2, "forgotten": 6 },
  "dueSoon": [ItemSummary]            
}
```

Each count links to `GET /api/items?view=<name>`.

## 7.5 Projects & members

| Method & path | Body / query | Success | Notes |
|---|---|---|---|
| `GET /api/projects` | – | `ProjectSummary[]` | Members: their projects. Admin: all (metadata) |
| `POST /api/projects` 🔑 | `{name, key, teamId, goal, template:'standard'|'approval'|'incident', managerId}` | 201 `ProjectDetail` | Admin. Creates workflow, stage frames, project node; `KEY_TAKEN` |
| `GET /api/projects/:projectId` | – | `ProjectDetail` | Members; Admins (metadata) |
| `PATCH /api/projects/:projectId` 🔢 | `{version, health?, statusNote?, name?, goal?}` | 200 `ProjectSummary` | status: Lead/Manager; name/goal: Manager |
| `GET /api/projects/:projectId/members` | – | `[{user: WorkerMini, role, since}]` | Every member (the Team page); Admins |
| `POST /api/projects/:projectId/members` 🔑 | `{userId, role, reason}` | 201 | Manager/Admin |
| `PATCH /api/projects/:projectId/members/:userId` 🔑 | `{role, reason}` | 200 | closes old row, inserts new; `LAST_MANAGER` |
| `DELETE /api/projects/:projectId/members/:userId` 🔑 | `{reason}` | 204 | sets `valid_to`; `LAST_MANAGER` |
| `GET /api/projects/:projectId/items/deleted` | cursor | `{items, nextCursor}` | Manager |
| `GET /api/teams` · `POST /api/teams` 🔑 | `{name}` | | POST: Admin |

## 7.6 Items

### List and search

`GET /api/items`

| Param | Values |
|---|---|
| `projectId` | uuid (optional; omitted = all my projects) |
| `view` | `assigned_to_me` · `next_actions_due` · `overdue` · `awaiting_my_approval` · `unassigned_urgent` · `blocked` · `forgotten` |
| `stageId`, `type`, `priority` | comma-separated lists |
| `assigneeId` | uuid, `me`, `none` |
| `due` | `overdue` · `today` · `week` |
| `q` | full-text query over title and description; a key like `PAY-4790` returns exactly that item |
| `sort` | `updated` (default, desc) · `priority` (asc, then due) · `due` (asc, nulls last) |
| `limit`, `cursor` | |

→ 200 `{ items: ItemSummary[], nextCursor, total: number, totalIsCapped: boolean }`
(`total` counts up to 10,000, then `totalIsCapped: true` → UI shows "10,000+").

### Item endpoints

| Method & path | Body | Success | Errors (besides 400/401/404) |
|---|---|---|---|
| `POST /api/items` 🔑 | `{projectId, type, title, description?, priority, dueAt?, assigneeId?}` | 201 `ItemDetail` | 403 (member assigning someone else); 422 `INVALID_ASSIGNEE` |
| `GET /api/items/:itemId` | – | 200 `ItemDetail` | 410 for deleted (Managers get the item with `deletedAt`) |
| `PATCH /api/items/:itemId` 🔢 | `{version, title?, description?, type?, dueAt?, priority?, nextAction?, nextActionDueAt?, reason?}` | 200 `ItemDetail` | 403 per field group; 422 `REASON_REQUIRED` (priority); 409 `VERSION_CONFLICT`; 410 |
| `POST /api/items/:itemId/claim` 🔑 | `{}` | 200 `ItemDetail` | 409 `ALREADY_CLAIMED`; 410 |
| `POST /api/items/:itemId/release` 🔑🔢 | `{version}` | 200 | 403 `NOT_ASSIGNEE`; 409; 410 |
| `POST /api/items/:itemId/assign` 🔑🔢 | `{version, assigneeId: uuid|null, reason}` | 200 | 403; 422 (not a member / reason); 409; 410 |
| `POST /api/items/:itemId/transition` 🔑🔢 | `{version, toStageId, reason?}` | 200 | see [04 §4.3](04-workflow-rules.md) |
| `DELETE /api/items/:itemId` 🔑🔢 | `{version, reason}` | 200 `{deleted: true, deletedAt}` | 403 `NOT_PROJECT_MANAGER`; 409; 410 |
| `POST /api/items/:itemId/restore` 🔑 | `{reason}` | 200 `ItemDetail` | 403 `NOT_PROJECT_MANAGER` |
| `GET /api/items/:itemId/activity` | `?filter=all|notes|changes&cursor&limit` | 200 `{items: ActivityEvent[], nextCursor}` | |
| `POST /api/items/:itemId/notes` 🔑 | `{kind:'note'|'decision'|'handoff'|'blocker', body}` | 201 `{event}` | 410 |
| `POST /api/items/:itemId/links` | `{blockerItemId}` | 201 `ItemDetail` (repeating an existing link returns the same state) | 422 `DEPENDENCY_CYCLE`; 404 (other project) |
| `DELETE /api/items/:itemId/links/:blockerItemId` | – | 204 | |

`PATCH` returns 409 `VERSION_CONFLICT` with:

```json
{ "current": ItemDetail,
  "changes": [{ "field": "priority", "from": 3, "to": 1, "by": UserMini, "at": "…", "eventId": "912" }] }
```

Links are naturally idempotent (unique constraint; repeating returns the existing state).

## 7.7 Workflow

All writes take the workflow lock and validate invariants; responses include the new
`workflowVersion` and the full `{stages, transitions}`.

| Method & path | Body | Notes |
|---|---|---|
| `GET /api/projects/:projectId/workflow` | – | `{version, stages, transitions}` |
| `POST /api/projects/:projectId/workflow/stages` | `{id, name, kind?, requiresApproval?, frame:{x,y,width,height}, insertOnTransitionId?, keepOriginalTransition?}` | client-generated `id` (idempotent); creates the stage and its `stage_frame`; with `insertOnTransitionId` turns A→B into A→new→B atomically |
| `PATCH /api/projects/:projectId/workflow/stages/:stageId` 🔢 | `{version, name?, kind?, requiresApproval?}` | kind/protection: Lead/Manager |
| `DELETE /api/projects/:projectId/workflow/stages/:stageId` | – | 409 `STAGE_NOT_EMPTY`; 422 `WORKFLOW_INVALID` |
| `POST /api/projects/:projectId/workflow/transitions` | `{id, fromStageId, toStageId, label?, requiresReason?, leadOnly?}` | flags: Lead/Manager; 422 `WORKFLOW_INVALID` (e.g. `APPROVAL_BYPASS`) |
| `PATCH /api/projects/:projectId/workflow/transitions/:transitionId` 🔢 | `{version, label?, requiresReason?, leadOnly?}` | |
| `DELETE /api/projects/:projectId/workflow/transitions/:transitionId` | – | Lead/Manager for flagged connections or ones entering a protected stage; may produce warnings |

## 7.8 Canvas

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/projects/:projectId/canvas` | – | `{project, workflow, elements: CanvasElement[], stages:[{stageId, count, items: ItemCard[]}], members: WorkerMini[], serverTime}` (top 20 items per stage) | |
| `POST /api/projects/:projectId/canvas/elements` | `{elements:[{id, type, x, y, width, height, zIndex, props}]}` (≤ 100) | 201 `{elements}`; existing ids by the same creator are returned unchanged | 422 `CANVAS_LIMIT_REACHED`; 409 if an id exists with a different creator |
| `PATCH /api/projects/:projectId/canvas/elements` | `{changes:[{id, version, x?, y?, width?, height?, zIndex?, props?}]}` (≤ 100) | 200 `{elements}` | 409 `ELEMENT_CONFLICT` `{conflicts:[{id, current}]}` (`current.deleted` or `null` when someone deleted it). All-or-nothing |
| `POST /api/projects/:projectId/canvas/elements/delete` | `{elements:[{id, version}]}` | 200 | 409 as above. `stage_frame`/`project_node` cannot be deleted here (use the workflow endpoint) |
| `POST /api/projects/:projectId/canvas/elements/restore` | `{ids:[…]}` | 200 `{elements}` | |
| `GET /api/projects/:projectId/stages/:stageId/items` | cursor | `{items: ItemCard[], nextCursor}` | "+32 more" |
| `GET /api/projects/:projectId/changes?since=<iso>` | – | `{serverTime, items: ItemCard[], elements: CanvasElement[], workflow: {version, stages, transitions} | null, project: Project | null, stageCounts: {[stageId]: number}}` | |

`workflow` and `project` are returned only if their version changed since `since`.

## 7.9 Presence

`POST /api/presence/heartbeat` `{resourceType:'item'|'canvas', resourceId, selectedElementIds?}`
→ 200 `{viewers:[{user: UserMini, selectedElementIds: string[], lastSeenAt}]}` (excluding the caller,
seen in the last 30 s). Sent every 20 s while a page is visible. Requires `project.view` on the resource.

## 7.10 Notifications

| Method & path | Body | Success |
|---|---|---|
| `GET /api/notifications` | `?unreadOnly=true&cursor&limit` | `{items:[{id, type, title, project:{id,key}, item:{id,key}|null, actor: UserMini, count?, createdAt, readAt}], nextCursor}` |
| `GET /api/notifications/unread-count` | – | `{count}` (capped at 99 → "99+") |
| `POST /api/notifications/:id/read` | – | 204 (idempotent) |
| `POST /api/notifications/read-all` | `{before?: iso}` | 204 (idempotent; only notifications created up to `before`, default now, so ones arriving meanwhile stay unread) |

## 7.11 People

| Method & path | Success |
|---|---|
| `GET /api/people/:userId` | `{user:{fullName, designation, department, employeeCode, email, joinedAt}, online, currentProjects:[{project, role, since, openItems}]}` |
| `GET /api/people/:userId/history` | `[{project, role, validFrom, validTo, reason}]` |
| `GET /api/people/:userId/stats?projectId&period=month|quarter|all` | `{claimed, resolved, approved, notes}` |
| `GET /api/people/:userId/activity?filter=all|decisions|approvals&cursor` | `{items: ActivityEvent[] (with item & project), nextCursor}` |

All filtered to projects the viewer shares (Admins: all). 404 if the viewer shares no project with
the person (unless self or Admin).

## 7.12 Admin & internal

| Method & path | Notes |
|---|---|
| `GET /api/directory` | Active users `{id, fullName, designation}` for pickers (any signed-in user) |
| `GET /api/admin/users` · `POST /api/admin/users` 🔑 | Create user `{email, fullName, designation, department, employeeCode, password, isAdmin}` |
| `POST /api/admin/users/:userId/active` | `{active: boolean}`: deactivate/reactivate (takes effect on the user's next request) |
| `GET /api/admin/jobs?status=failed&cursor` | Failed outbox jobs with `lastError`, `attempts` |
| `POST /api/admin/jobs/:jobId/retry` | Resets to `pending`, `attempts=0` |
| `POST /api/internal/outbox/run` | Header `X-Cron-Secret` (wrong secret → 404); drains up to 5 batches of 50 jobs and runs housekeeping; returns `{processed, removed}`; used by the scheduler on serverless hosting |
| `GET /api/health` | `{ok: true, db: "up"}`; 503 if the DB is unreachable |

## 7.13 Assistant

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /api/assistant/status` | – | `{enabled: boolean, model: string}` | |
| `POST /api/assistant/chat` | `{messages: [{role: 'user'|'assistant', content}] (last must be user; ≤ 2,000 chars each), projectId?}` | 200 `{answer, references: [{id, key, title}], steps: [{tool, label}]}` | 503 `ASSISTANT_DISABLED`; 429 `RATE_LIMITED`; 502 `ASSISTANT_FAILED` |

Not idempotency-keyed because it changes nothing. `projectId` is only used as a default scope, and
only if the caller is a member of that project. See [13](13-assistant.md).
