# Engineering Decisions

Six decisions that shaped Newtonite Ops, each with its context, the options considered, the choice
and the trade-off. Detailed design is in [docs/](docs/README.md).

---

## 1. One transaction per action: change, history and outbox job

**Context.** Important actions must never silently disappear, and history must always agree with the
data. Writing history or notifications in a separate step risks losing them if the process fails in
between.

**Options.** (a) Write history and publish jobs after the main update. (b) Database triggers.
(c) Write the change, an `activity_events` row and an `outbox` row in one transaction from the
service layer.

**Choice.** (c). Every write follows the same path: scoped load → `authorize()` → domain rule check →
versioned update → activity event (with the actor's role at that moment) → outbox job → commit. A
database trigger additionally rejects `UPDATE` and `DELETE` on `activity_events`.

**Trade-off.** More code per endpoint than triggers, but the logic stays explicit and testable in
TypeScript, and history can never disagree with the data.

---

## 2. Optimistic concurrency, atomic claims and idempotency keys

**Context.** Two people claim the same item, someone edits data that has just changed, and users
repeat requests when unsure whether the first succeeded.

**Options.** (a) Last write wins with disabled buttons. (b) Pessimistic locks while an item is open.
(c) Version checks on every write, conditional updates for races, and server-side idempotency keys.

**Choice.** (c).
- Items and canvas elements carry a `version`. A stale write returns 409 with the current data and
  the changes since the client's version; the UI re-applies non-overlapping edits or shows a
  conflict panel. Canvas batches are all-or-nothing and lock rows in a fixed order.
- Claims are one statement, `UPDATE … WHERE assignee_id IS NULL`, so exactly one caller wins.
- `Idempotency-Key` is stored with the response in the same transaction as the effect. A concurrent
  duplicate waits on the key and replays the stored response; a reused key with a different body is
  rejected.

**Trade-off.** Users occasionally resolve a conflict, and the client must track versions. Pessimistic
locks were rejected because tabs stay open for hours. Idempotency costs one extra write per request
and a table purged after 24 hours, but needs no extra infrastructure and works across instances.

---

## 3. The workflow is data, guarded by graph invariants

**Context.** Each project needs its own workflow, editable on the canvas, while approval steps must
remain enforceable.

**Options.** (a) A hard-coded state machine. (b) Free editing without checks. (c) A stored graph of
stages and transitions validated by the server.

**Choice.** (c). A pure function, `checkTransition()`, validates every move and also produces the
allowed moves shown in the UI. Workflow edits must keep exactly one start stage and must not create
an **approval bypass** (a path to a done stage that skips every protected stage); unreachable stages
and dead ends are warnings, since the graph is built one step at a time. Workflow edits take the
workflow row `FOR UPDATE` and item moves take it `FOR SHARE`, so an item cannot move along a
connection being deleted.

**Trade-off.** More complex than a fixed status enum. Items always follow the current graph; workflow
versions are not snapshotted.

---

## 4. Project-scoped roles enforced in one place

**Context.** Users belong to several teams with different responsibilities, and authorization must
not depend on hidden buttons.

**Options.** (a) Global roles. (b) Team-level roles. (c) Per-project roles (Manager, Lead, Member)
with history, plus a company-wide Admin flag.

**Choice.** (c). Every query joins the caller's current memberships, so other projects' data is
never loaded. `authorize(actor, action, resource)` holds the permission matrix in one file.
Non-members get 404, so existence is hidden; members without a permission get a 403 with a specific
code. Roles are read on each request, never stored in the session. The Ask assistant only calls
read-only tools built on the same services, so it can never see or do more than its user.

**Trade-off.** One indexed join per query, in exchange for role changes taking effect immediately.

---

## 5. Asynchronous work through a Postgres outbox

**Context.** Notifications, canvas digests and profile statistics should not slow or endanger the
primary action, and must survive failures, duplicates and delays.

**Options.** (a) Do the work synchronously in the request. (b) A message broker such as Redis/BullMQ.
(c) An `outbox` table processed by a worker.

**Choice.** (c). The job commits atomically with the change. The worker claims jobs with
`FOR UPDATE SKIP LOCKED`, holds a 60 s lease, retries with exponential backoff and marks a job failed
after 5 attempts; admins can retry failed jobs. Handlers are idempotent (unique constraint on
recipient and source event), so running a job twice creates one notification. The worker also purges
expired idempotency keys and finished jobs.

**Trade-off.** Polling a table is less efficient than a broker at very high volume, and notifications
arrive seconds after the action. At larger scale the outbox would feed a dedicated queue.

---

## 6. Polling a changes feed instead of WebSockets

**Context.** Users must see others' changes on the canvas and lists.

**Options.** (a) WebSockets or a real-time CRDT. (b) Server-sent events. (c) Polling a cheap
"changes since T" endpoint.

**Choice.** (c). The canvas polls every 3 s, every 1 s while changes keep arriving, and immediately
after the user's own writes; other screens refresh every 15–30 s and on focus. The server returns
rows updated after `since − 30 s` to cover late-committing transactions, and the client applies only
newer versions, patching cards in place.

**Trade-off.** About 1–3 s delay and constant light load from open canvases. Correctness never
depends on freshness because every write is version-checked. Server-sent events are the next step.

---

## Not built, deliberately

| Not built | Reason |
|---|---|
| Real-time collaborative canvas (CRDT) | Per-element versions with polling give safe collaboration within the time box |
| Email or Slack delivery, attachments, SSO | Infrastructure that does not demonstrate the core behaviours |
| Hard delete | History must not disappear; soft delete with reason and restore instead |
| Notification preferences, rate limiting | Listed as next steps |
| Multi-tenancy | One company per deployment; `org_id` exists for a later move |
