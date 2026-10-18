# 1. Product Spec

## 1.1 Problem

Newtonite coordinates operational work through chat, spreadsheets, email and conversations. With
several hundred employees this fails: requests disappear in threads, two people work on the same
issue unknowingly, edits are made against outdated information, ownership changes are invisible,
and management cannot see what is happening, who owns it, what is urgent, what was forgotten, or
why a decision was made.

## 1.2 Product in one paragraph

Newtonite Ops gives every team **projects**. A project holds **work items** (anything that needs
investigation, action or resolution) that move through the project's **workflow**. The workflow is
drawn on a shared **canvas** that any project member can edit: stages are frames, allowed moves are
connections, and work items are cards inside the stages showing who owns them. Every change is
recorded in an append-only **history**, every member is **notified** of changes, and the server
enforces **permissions**, **workflow rules** and **concurrency safety** no matter how the API is
called.

## 1.3 Glossary

| Term | Meaning |
|---|---|
| Organization | The customer company. v1 runs one organization per deployment: **Newtonite**. |
| Team | A department that groups projects (Finance, Platform, …). Grouping only; it grants no access. |
| Project | A unit of work owned by a team, with its own members, workflow, canvas and items. Identified by a UUID, a name and a short key (`PAY`). |
| Member | A user with an active role in a project: **Manager**, **Lead** or **Member**. |
| Work item | One request or task, e.g. `PAY-4790`. Has type, priority, stage, assignee, due date, next action, version. |
| Stage | A step of the workflow (Open, In Progress…). Kind: `start`, `active` or `done`. |
| Transition | A connection between two stages = an allowed move. |
| Protected stage | A stage that can only be entered through approval (e.g. *Approved*). |
| Next action | The single next step for an item, with an optional due time ("Confirm reversal with bank, today 4pm"). |
| Note | A typed comment on an item: Note, Decision, Handoff or Blocker. Immutable once posted. |
| Activity event | An append-only history record of one change, including the actor's role at that moment. |
| Worker node | The assignee shown on an item card: name, job title, project role, workload. |

## 1.4 Users and roles

Roles are **per project**. The same person can be Lead in one project and Member in another.

| Role | Typical person | Summary |
|---|---|---|
| **Member** | Engineer, analyst, support agent | Creates and claims items, works items assigned to them, comments, edits the canvas. |
| **Lead** | Team lead | Everything a Member can do, plus approve/reject, reassign, change priority, reopen, change workflow rules. |
| **Manager** | Project manager / owner | Everything a Lead can do, plus edit item details, delete and restore items, edit project details, manage members. Exactly one per project. |
| **Admin** | IT / operations admin (company-wide flag) | Creates teams, projects and users, assigns Managers, sees failed background jobs. Sees project **metadata** (name, health, counts) but **not** items or canvases unless also a member. |

People who are not members of a project cannot see that it exists (the API returns 404).

## 1.5 Feature list

Priority tiers: **Core** must ship with tests. **Differentiator** ships after Core. **Stretch** only if time remains.

### Core

| # | Feature | Details |
|---|---|---|
| C1 | Login | Email + password, httpOnly session cookie. Demo "Sign in as…" list of seeded users when `DEMO_MODE=true`. No sign-up. |
| C2 | Teams, projects, project roles | Role history kept with start/end dates. |
| C3 | Work items | Type (incident, customer issue, payment, compliance, task), title, description, priority P1–P4, stage, assignee, creator, due date, next action, version, timestamps, human key `PAY-4790`. |
| C4 | Workflow as data | Per-project graph of stages and transitions, created from a template (Standard, Approval, Incident). All moves enforced by the server. |
| C5 | Approval | Entering a protected stage requires a Lead/Manager who is neither the item's creator nor its assignee. |
| C6 | Atomic claim | Exactly one of several simultaneous claimers wins. |
| C7 | Stale-edit protection | Version check on every update; 409 with latest data and what changed. |
| C8 | Idempotent writes | `Idempotency-Key` on every non-naturally-idempotent write; retries return the original response. |
| C9 | Resource-level authorization | One `authorize()` function; every query scoped to the caller's projects. |
| C10 | Activity history | Append-only, written in the same transaction as the change, records actor and actor's role. |
| C11 | Notes and reasons | Typed notes; a reason is mandatory for priority changes, reassignment, reject, reopen, delete and restore. |
| C12 | Notifications | Every change notifies all other project members via a transactional outbox and an idempotent worker. In-app inbox with unread count. |
| C13 | Home dashboard | Assigned to me, Next actions due, Awaiting my approval, Unassigned urgent, Blocked, Forgotten, Overdue. |
| C14 | List & search | Server-side filtering, full-text search, cursor pagination, filters in the URL. |
| C15 | Soft delete & restore | Manager only; deleted items vanish from views but stay in history. |

### Differentiators

| # | Feature | Details |
|---|---|---|
| D1 | Project canvas | Excalidraw-style canvas per project: project node, stage frames, connections, item cards with worker nodes, free drawing (shapes, text, sticky notes, arrows, freehand). Drag a card between stages to move it. |
| D2 | Workflow editing on the canvas | Members add stages and connections; server enforces workflow invariants (see [04](04-workflow-rules.md)). |
| D3 | Dependencies | "Blocked by" links within a project; no cycles; blocked items cannot enter a `done` stage. |
| D4 | Presence | "Ravi is viewing this item", and canvas selection indicators. |
| D5 | People profiles | Job title, current projects and roles, role history, contribution stats, activity. |
| D6 | Conflict panel | Field-level view of what changed; automatic re-apply when fields don't overlap. |
| D7 | Admin screens | Teams, projects, members, failed jobs with Retry. |
| D8 | Team page | Every project member sees everyone's role, job title, open items and start date; only the Manager/Admin changes roles. |
| D9 | Stage dropdown with reasons | Item detail shows the stage as a dropdown: allowed moves selectable, refused moves disabled with the reason ("someone else must approve"), unconnected stages disabled. |
| D10 | ✨ Ask assistant (optional) | Chat on the canvas and list pages answering questions about visible work, using Groq `openai/gpt-oss-120b` and read-only tools that run with the user's permissions ([13](13-assistant.md)). Off unless `GROQ_API_KEY` is set. |

### Stretch (not built)

Roster panel drag-to-assign on the canvas; dependency lines on the canvas; hand-drawn rendering
style; canvas undo; named saved filters (filters are shareable through the URL instead).

## 1.6 Notification rules

* **Who:** every **current** member of the project, **except the person who made the change**.
* **What:** every item change (create, update, claim, release, assign, transition, approve, reject,
  reopen, delete, restore, note, link), project changes, membership changes, workflow changes.
* **Canvas drawing edits** (shapes, text, sticky notes, positions) are **grouped**: one notification
  per editor per project per 10-minute window — "Ravi edited the canvas (12 changes)".
* **Delivery:** in-app only. The bell polls the unread count every 15 seconds.
* **Guarantees:** never lost (outbox in the same transaction), never duplicated (unique constraint),
  retried with backoff, failures visible to Admins.

## 1.7 Assumptions

Assumptions marked ★ are the ones we would confirm with a product manager first.

1. ★ Only project members may see a project, its items and its canvas. Management oversight comes through Project Managers and the Admin's metadata view.
2. ★ Every member is notified of every change. In large projects this is noisy; per-user notification preferences are the next step.
3. ★ Only the Manager edits an item's title, description, type and due date; others add notes.
4. Exactly one active Manager per project.
5. Members may move only items assigned to them; they claim an unassigned item first. Leads and Managers may move any item.
6. Approval follows the four-eyes principle: approver ≠ creator and ≠ assignee.
7. Dependencies exist only within one project.
8. Notes are immutable; corrections are new notes.
9. Deleting an item is a soft delete with a reason; history is never erased.
10. One organization per deployment; every table still carries `org_id` so multi-tenant hosting is a later step.
11. Users are created by Admins (seeded for the demo); no self sign-up, SSO or email.
12. Times are stored in UTC and displayed in the browser's time zone.

## 1.8 Out of scope (deliberately not built)

Email/Slack delivery, file attachments, SSO, websockets / real-time CRDT collaboration, per-user
notification preferences, cross-project dependencies, general API rate limiting (only the assistant
is rate-limited), SLA timers and escalation, mobile app, Gantt charts, timesheets, analytics
dashboards, AI that changes data (the assistant is read-only). Reasons are in
[ENGINEERING_DECISIONS.md](../ENGINEERING_DECISIONS.md).

## 1.9 How the brief is covered

| Brief requirement | Where it is addressed |
|---|---|
| What the item is and why it exists | Item title + description; card "why" line ([08](08-frontend-views.md), [09](09-canvas-spec.md)) |
| Current state and importance | Stage + priority + due date, visible on card and detail |
| Who is responsible | Assignee worker node; claim/assign flows |
| What has happened previously | Activity timeline with actor role and reasons |
| What requires attention next | Next action field, Home dashboard views |
| Multiple teams, users in several teams, different responsibilities | Teams group projects; per-project roles; role history ([06](06-permissions.md)) |
| Authorization enforced by the system | `authorize()` + query scoping; 404/403 ([06](06-permissions.md)) |
| History; important actions never silently disappear | Append-only activity in the same transaction; soft delete; DB trigger blocks history edits |
| Two users taking responsibility | Atomic claim ([05 §2](05-data-flows.md)) |
| Viewing information another user changed | Changes feed polling + version checks ([05 §3, §9](05-data-flows.md)) |
| Many updates in a short period | Row locks + versions; ordered event ids |
| Repeating an action | Idempotency keys ([05 §4](05-data-flows.md)) |
| Overview, find work without browsing everything | Home dashboard, filters, search, pagination |
| Usable as data grows | Cursor pagination, indexes, top-N per canvas stage, no full loads |
| Async processing, failures, duplicates, delays | Transactional outbox + idempotent worker ([05 §7](05-data-flows.md)) |
| ≥ 3 behaviours beyond CRUD | 7 implemented: concurrent claim, stale edits, idempotency, workflow rules, resource authz, reliable async, optimistic UI reconciliation |
| ENGINEERING_DECISIONS.md | Repository root |
| Tests for dangerous behaviour | [11](11-test-plan.md) |
| Known limitations | §1.10 below and the README |

## 1.10 Known limitations (v1)

* Polling instead of push: canvas changes from others appear in about 1 s (3 s when quiet); lists
  and the dashboard refresh every 15–30 s.
* Canvas holds at most 2,000 drawing elements per project and loads them all at once.
* Each canvas stage shows the top 20 items; the rest are reached through the list view.
* Dependencies are shown as ⛓ badges, not drawn as lines; no canvas undo.
* "Every member is notified" will be too noisy for very large projects.
* Free serverless hosting: background jobs run at most every minute when idle.
* No general rate limiting or login throttling (the assistant has a per-user limit).
* The assistant's rate limit is per server process; answers are not streamed.
