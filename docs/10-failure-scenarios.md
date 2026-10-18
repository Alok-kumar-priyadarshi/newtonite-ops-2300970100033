# 10. Failure Scenarios

How the system behaves when things go wrong. "Safe" means: no lost or duplicated data, and the
user is told what happened.

## 10.1 Infrastructure

| Failure | Behaviour | User sees |
|---|---|---|
| Database unreachable | Requests fail fast (connection timeout 5 s) with 503 `SERVICE_UNAVAILABLE` + `Retry-After: 5`. Nothing is partially written: every write is a single transaction. `/api/health` reports `db: down`. | The action is retried automatically with the same idempotency key (up to 2 times); then a toast "…your last action was not saved." and the optimistic change rolls back |
| Database fails mid-transaction | Postgres rolls back the whole transaction: change, activity and outbox row all disappear together. The idempotency key row also rolls back, so a retry runs fresh. | Same as above |
| Slow query or lock wait | `statement_timeout = 10 s`, `lock_timeout = 5 s` → 503; logged with request id | Error toast; retry possible |
| Idle connections closed, then a burst of queries | Measured during development: reconnecting ~10 connections at once took ~13 s on Windows + Docker. The pool now keeps idle connections open (`DB_IDLE_TIMEOUT=0`) and recycles them every 30 min | Nothing (fixed) |
| API instance crashes mid-request | Uncommitted transaction rolled back by Postgres. Client sees a network error and retries with the same key. If the commit had happened just before the crash, the retry replays the stored response. | Possibly one automatic retry; no duplicate |
| Worker crashes mid-job | Job stays `processing` until `locked_until` (60 s) passes, then is reclaimed. Handlers are idempotent. | Notification arrives up to ~1–2 min late |
| Worker not running / scheduler down | Jobs accumulate as `pending`. Primary actions are unaffected. On Vercel, `waitUntil` after each write still drains jobs. | Notifications delayed |
| Job keeps failing | Exponential backoff 2, 4, 8, 16 s; after 5 attempts `failed` with `last_error`. Other jobs continue (`SKIP LOCKED`, ordered by id but not blocked by the failed one). | Admin sees it under Failed jobs and can Retry |
| Serverless cold start | First request after idle is slower (~1 s) | Brief spinner |

## 10.2 Concurrency and user behaviour

| Situation | Behaviour | Details |
|---|---|---|
| Two users claim the same item | One wins; other gets 409 `ALREADY_CLAIMED` naming the winner | [05 §5.2](05-data-flows.md) |
| Edit based on stale data | 409 `VERSION_CONFLICT` with current item + changes; auto re-apply if no overlap | [05 §5.3](05-data-flows.md) |
| A form stays open while the page refreshes in the background | The form sends the version it was opened with, so the refresh can't hide someone else's change; the form warns "updated while you were editing" | [05 §5.3](05-data-flows.md) |
| Double-click / client retry | Idempotency key → one effect, identical response | [05 §5.4](05-data-flows.md) |
| Many updates to one item in a burst | Serialized by row lock; each must carry the latest version; later ones with stale versions get 409 | Version numbers give a total order per item |
| Two Leads decide the same approval | First wins; second gets 409 (version) or 422 (no longer in that stage) | |
| Manager deletes an item someone is editing | Their save gets 410 `ITEM_DELETED` with who/why | [05 §5.11](05-data-flows.md) |
| Workflow edited while items are moving | Workflow edits take `FOR UPDATE`, transitions `FOR SHARE` on the workflow row; they serialize | [04 §4.4](04-workflow-rules.md) |
| Two edits that together would break the workflow | Serialized; the second is validated against the result of the first and rejected | |
| Member tries to route around approval | 422 `WORKFLOW_INVALID` / `APPROVAL_BYPASS` | [04 §4.4](04-workflow-rules.md) |
| Dependency cycle | 422 `DEPENDENCY_CYCLE` | |
| User removed from a project while logged in | Next request: 404 for that project (roles are read on every request). The sidebar drops the project when the user's data refreshes (within a minute, or on returning to the tab). | |
| User deactivated | Next request: 401; redirected to login | |
| Two canvas edits to the same element | Second gets `ELEMENT_CONFLICT`; element snaps to server copy | [05 §5.10](05-data-flows.md) |
| Changes feed misses a late commit | 30 s overlap window + version-based merge | [02 §2.7](02-architecture.md) |
| Idempotency key reused for a different action | 422 `IDEMPOTENCY_KEY_REUSED` | |

## 10.3 Security-relevant failures

| Attempt | Result |
|---|---|
| Calling the API for another team's item | 404 — existence not revealed |
| Member calling delete/approve/assign directly | 403 with a specific code; nothing written |
| Forged cross-site POST | 403 `CSRF_HEADER_MISSING` (cookie is SameSite=Lax by default; with `CORS_ORIGINS`, only listed origins pass the preflight) |
| Tampered session token | Signature check fails → 401 |
| Editing history through any endpoint | No endpoint exists; DB trigger rejects UPDATE/DELETE on `activity_events` |
| Oversized payloads | JSON body limit 256 KB → 413 |
| Brute-force login | Not mitigated in v1 (no login rate limiting): a known limitation. Unknown email and wrong password give the same message and take the same time |
| Asking the assistant about another team's work | Its tools run as the user, so they return nothing / "No one called …"; the model never receives that data |
| Prompt injection inside an item ("ignore your rules…") | Tool data is declared as user-written data; the assistant has no write tools and no wider access, so at worst it gives a wrong answer |

## 10.4 Assistant (optional feature)

| Failure | Behaviour | User sees |
|---|---|---|
| No `GROQ_API_KEY` | `ASSISTANT_DISABLED` (503); rest of the app unaffected | Panel explains how to switch it on |
| Wrong key | `ASSISTANT_FAILED` (502) | "The AI service rejected the API key…" |
| Provider busy / rate-limited, or > 15 questions a minute | `RATE_LIMITED` (429) | "Please try again in a moment" |
| Provider slow or down | 30 s timeout → `ASSISTANT_FAILED` | "The AI service did not respond…" |
| Model calls a tool with bad arguments or an unknown item | The error goes back to the model as the tool result, so it can correct itself or explain | A normal answer ("PAY-99999 doesn't exist") |
| Model keeps calling tools | After 6 tool rounds it must answer without tools | An answer from what it found |

## 10.5 Observability

* Every API request logs one JSON line: request id, user id, route, status, duration.
* Errors (5xx) log stack traces with the request id; the id is returned to the client in the error body.
* The worker logs failed jobs (id, type, attempts, error) and each housekeeping run.
* The assistant logs upstream errors (status and a short excerpt), never the API key.
* `GET /api/health` checks the database.
