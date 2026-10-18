# 11. Test Plan

The brief asks for tests of the behaviours that would be **dangerous if wrong**. Coverage percentage
is not a goal. Tests run against a **real PostgreSQL** because the risky behaviour lives in row locks,
constraints and transactions, which mocks would hide.

**Result today:** 80 backend tests + 6 frontend tests, all passing with `npm test`.

## 11.1 Setup

* **Runner:** Vitest. **HTTP:** Supertest against `createApp()` (no network port).
* **Database:** `docker-compose.test.yml` starts Postgres on port 55432 (in-memory storage); tests run
  migrations once, then each test truncates the tables and inserts a small fixture (2 projects,
  6 users with known roles: manager, lead, two members, an outsider, an admin).
* **Concurrency tests** fire requests with `Promise.all`; the pool has 20 connections so the requests
  truly overlap in the database.
* **Worker tests** call `processOutboxBatch()` directly; failing handlers are injected.
* **Assistant tests** replace Groq with a scripted fake; tests never use a real API key.
* **One command:** `npm test` (starts the test database if needed, runs API and web tests).

## 11.2 Tests by risk

✅ implemented · ⚠️ partly · ❌ not implemented (see "next steps")

### A1 Concurrent actions

| Test | Expectation | |
|---|---|---|
| 10 parallel claims of one unassigned item | Exactly one person ends up owning it; the others get 409 `ALREADY_CLAIMED`; exactly 1 `item.claimed` event | ✅ |
| 20 parallel item creates in one project | 20 distinct, consecutive numbers | ✅ |
| Parallel transition + workflow edit deleting that connection | Either the move commits before the delete, or it fails with `INVALID_TRANSITION`; never a move along a deleted connection | ✅ |
| Two parallel workflow edits, each valid alone, together creating an approval bypass | One succeeds, the other gets 422 `APPROVAL_BYPASS` | ✅ |
| Two canvas batches touching the same elements in opposite order | One succeeds, the other gets a clean 409; never a deadlock (rows are locked in id order) | ✅ |

### A2 Stale data

| Test | Expectation | |
|---|---|---|
| PATCH with an old version | 409 `VERSION_CONFLICT` with current item and the change list; DB row unchanged | ✅ |
| Transition with an old version | 409; stage unchanged; no history written | ✅ |
| Canvas batch where one element is stale | 409 `ELEMENT_CONFLICT`; **no** element in the batch changed | ✅ |
| Act on a deleted item | 410 `ITEM_DELETED` with who and why | ✅ |
| A form left open while the page refreshes | Saves with the version it was opened with → conflict panel on overlap, auto re-apply otherwise | ⚠️ verified in the browser, no automated UI test |

### A3 Duplicate operations

| Test | Expectation | |
|---|---|---|
| Same `Idempotency-Key` twice on create | 1 item; identical response; second has `Idempotent-Replayed: true` | ✅ |
| Same key **in parallel** (5 requests) | 1 item | ✅ |
| Same key, different body | 422 `IDEMPOTENCY_KEY_REUSED` | ✅ |
| Missing key | 428 | ✅ |
| A refused request replayed for its key; a new key can then succeed | Same 403 replayed; new key → 200 | ✅ |
| Canvas create repeated with the same element id | 1 element | ✅ |
| Keys expire after 24 h | Cleanup removes old keys, keeps fresh ones | ✅ |

### A4 Workflow rules

| Test | Expectation | |
|---|---|---|
| Open → Closed (no connection) | 422 `INVALID_TRANSITION` | ✅ |
| Member moves an item not assigned to them | 403 `NOT_ASSIGNEE` | ✅ |
| Member approves | 403 `APPROVAL_ROLE_REQUIRED` | ✅ |
| Lead approves an item they are assigned to / created | 403 `SELF_APPROVAL_FORBIDDEN` | ✅ |
| Finish with an open blocker | 409 `BLOCKED_BY_OPEN_ITEMS`; succeeds after the blocker is done | ✅ |
| Reject without reason | 422 `REASON_REQUIRED` | ✅ |
| Member adds `In Progress → Closed` in an approval workflow | 422 `APPROVAL_BYPASS` | ✅ |
| Insert a step between two steps | A→B becomes A→new→B | ✅ |
| Delete the start stage / a stage with items | 422 / 409 `STAGE_NOT_EMPTY` | ✅ |
| Member toggles protection | 403 `LEAD_OR_MANAGER_REQUIRED` | ✅ |
| Dependency cycle A→B→A | 422 `DEPENDENCY_CYCLE` | ✅ |
| **Unit:** every `checkTransition` rule, `allowedTransitions`/`blockedTransitions`, `analyzeWorkflow` (I1, I4, warnings), done → done is not a reopen | All rules | ✅ |

### A5 Resource-level authorization

| Test | Expectation | |
|---|---|---|
| Non-member: read item, edit, claim, canvas, project | 404 each | ✅ |
| Non-member search | Never returns the other project's items | ✅ |
| Member deletes | 403 `NOT_PROJECT_MANAGER` with "Only the Project Manager can delete items." | ✅ |
| Member reassigns / changes priority; Lead edits title | 403 with the specific code | ✅ |
| Removed member uses their existing session | 404 on the next request | ✅ |
| Inactive user | 401 | ✅ |
| CSRF header missing | 403 | ✅ |
| Admin (non-member) | Sees project metadata; 404 on items and canvas | ✅ |
| Profile of someone in no shared project | 404 | ✅ |
| Team list | Every member sees all roles; outsider 404; Lead can't change roles | ✅ |
| **Unit:** the whole permission matrix, every action × role | Matches [06 §6.3](06-permissions.md) | ✅ |

### A6 Reliable async processing

| Test | Expectation | |
|---|---|---|
| A change writes exactly one outbox job; a refused change writes none | ✅ | ✅ |
| Recipients | All current members except the actor; a member removed before processing gets nothing | ✅ |
| Same job processed twice (expired lease) | One notification per person | ✅ |
| Handler keeps failing | Backoff, then `failed` after 5 attempts; Admin retry delivers it | ✅ |
| Two workers in parallel | Each job processed exactly once (`SKIP LOCKED`) | ✅ |
| 12 canvas saves, jobs retried | One grouped notification with count 12 | ✅ |
| Stats event processed twice | Counted once | ✅ |
| Forced database failure after the change was written | Change, history and job all roll back | ⚠️ covered indirectly (refused changes write nothing; everything shares one transaction), no fault-injection test |

### A7 History integrity

| Test | Expectation | |
|---|---|---|
| Role recorded at the time | Old events keep the old role after a promotion | ✅ |
| `UPDATE`/`DELETE activity_events` in SQL | Raises an exception (trigger) | ✅ |
| Notes don't bump the version | A note never causes an edit conflict | ✅ |
| Every write endpoint creates exactly one event | One event per action | ⚠️ asserted for create, update, claim and approve; not one test per endpoint |

### A8 Pagination and search

| Test | Expectation | |
|---|---|---|
| Walk all pages while new items are inserted | No duplicates, nothing skipped | ✅ |
| Priority sort across pages (cursor carries "no due date") | Ordered and complete | ✅ |
| Combined filters (stage + priority + owner + text) | Equal to a direct SQL count | ✅ |

### A9 Assistant

| Test | Expectation | |
|---|---|---|
| No key | 503 `ASSISTANT_DISABLED` | ✅ |
| Tool call runs as the user, result goes back to the model, answer links item keys | ✅ | ✅ |
| Outsider asks about another project | Search returns nothing, person lookup fails, prompt lists only their own project | ✅ |
| Bad tool arguments / unknown item | Returned to the model as an error it can recover from | ✅ |
| Typographic hyphens in keys ("PAY‑42") | Normalised and linked | ✅ |
| Provider busy (429) | One retry, then a clear error | ✅ |
| Rejected key | Clear `ASSISTANT_FAILED` | ✅ |

### A10 Frontend

| Test | Expectation | |
|---|---|---|
| Canvas drop hints mirror the server rules | Members can't approve or move others' cards; blocked items can't finish | ✅ |
| Changes-feed patching | Moved cards change stage, counts update, deleted removed, older versions ignored | ✅ |
| `useSafeMutation` rollback; same key reused on retry | — | ❌ verified manually in the browser only |
| End-to-end flows (Playwright) | — | ❌ next step |

## 11.3 Where the tests live

| File | Covers |
|---|---|
| `backend/test/unit/rules.test.ts` | A4 and A5 unit tests (rules and permission matrix) |
| `backend/test/concurrency.test.ts` | A1 |
| `backend/test/stale-and-duplicates.test.ts` | A2, A3 |
| `backend/test/workflow-and-authz.test.ts` | A4, A5 |
| `backend/test/outbox-and-history.test.ts` | A6, A7, A8, housekeeping |
| `backend/test/assistant.test.ts` | A9 |
| `backend/test/unit/cors.test.ts` | CORS allow-list for a frontend on another domain (listed origin allowed with credentials, others get no CORS headers) |
| `frontend/src/canvas/context.test.ts`, `applyChanges.test.ts` | A10 |

During development the main flows were also checked in a real browser (headless Edge): canvas
drag with snap-back on refusal, Member delete refused, approval-bypass refused, stale form → conflict
panel, Team page, Ask panel, and two users seeing each other's changes (~1 s). Those scripts were
not added to the repository; turning them into Playwright tests is the first next step.

## 11.4 Manual demo script (for the live review)

1. Sign in as Meera and Ravi in two browsers. Both click Claim on the same item → one wins.
2. Both open the same item; Ravi changes priority; Meera changes priority → conflict panel.
3. Meera drags a card into *Approved* → snaps back, "Only a Lead or the Manager can approve".
4. Meera adds a stage "Bank verification" between In Progress and Awaiting Approval (click the
   connection → Insert a step here); Ravi's canvas shows it within seconds; Meera connects
   In Progress → Closed → "would let items reach a finished stage without approval".
5. Meera clicks Delete → "Only the Project Manager can delete items."
6. Tara opens a copied item link → Not found.
7. Stop the worker container (`docker compose stop worker`), make changes, start it again →
   notifications arrive once each.
8. Show an item's history and Ravi's profile ("approved … (as Lead)", promoted from Member).
9. (If a Groq key is set) Ask: "What is Meera working on?" as Ravi, then the same as Tara.
