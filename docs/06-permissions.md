# 6. Permissions

## 6.1 Model

* **Authentication:** email + password (bcrypt) → signed session token (JWT, 8 h) in an `httpOnly`,
  `SameSite=Lax` cookie, also `Secure` when the app is served over https (`APP_ORIGIN`). Only when
  `CORS_ORIGINS` is set (frontend calling from another domain) is it `SameSite=None; Secure`. The token
  contains only the user id. Unknown email and wrong password get the same message, and a dummy
  hash is compared for unknown emails so response time doesn't reveal which accounts exist.
* **Authorization data is loaded per request**, never trusted from the token: the user row
  (`is_active`, `is_admin`) and their current `project_members` rows. A role change or removal applies
  to the very next request.
* **CSRF:** every non-GET request must carry `X-Requested-With: newtonite-ops`, a header a
  cross-site form cannot set (missing → 403 `CSRF_HEADER_MISSING`); by default the cookie is also
  `SameSite=Lax`. With `CORS_ORIGINS`, a custom header forces a browser preflight that only the listed
  origins pass, so the protection holds with `SameSite=None` too.

## 6.2 Two layers of enforcement

1. **Scoping (who can see).** Every query that reads project data joins on the caller's current
   memberships. Data from other projects is never loaded, so it cannot leak through lists, search,
   counts, canvas, history, profiles or the changes feed.

   ```sql
   SELECT i.* FROM work_items i
   JOIN project_members m
     ON m.project_id = i.project_id AND m.user_id = $actor AND m.valid_to IS NULL
   WHERE i.id = $1 AND i.deleted_at IS NULL;
   ```

2. **Action check (what they can do).** `authorize(actor, action, resource)` in
   `domain/permissions.ts`: a pure function using the matrix below (`MATRIX`) plus the one
   resource-level condition "is the caller the assignee" ("own"). Every write calls it.
3. **Workflow rules (which moves).** `checkTransition()` in `domain/transitions.ts` adds the
   move-specific rules on top: Lead-only connections, approval by a Lead/Manager who is neither
   the creator nor the assignee, blockers, reasons ([04](04-workflow-rules.md)).

Those three are the only places permission decisions are made.

### 404 versus 403

| Situation | Response | Why |
|---|---|---|
| Resource doesn't exist, or caller isn't a member of its project | **404 `NOT_FOUND`** | Does not reveal that a project or item exists |
| Caller is a member but their role or relationship doesn't allow the action | **403** with a specific code | The UI can explain exactly why |

## 6.3 Permission matrix

| Action (`code`) | Member | Lead | Manager | Admin (non-member) | Condition / 403 code |
|---|---|---|---|---|---|
| View project, items, canvas, history (`project.view`) | ✓ | ✓ | ✓ | – (metadata only) | |
| See project metadata: name, health, counts (`project.view_meta`) | ✓ | ✓ | ✓ | ✓ | |
| See the team: every member, their role, job title, open items (part of `project.view`) | ✓ | ✓ | ✓ | ✓ | |
| Create item (`item.create`) | ✓ | ✓ | ✓ | – | Members may assign only themselves |
| Claim (`item.claim`) | ✓ | ✓ | ✓ | – | Item unassigned |
| Release (`item.release`) | own | ✓ | ✓ | – | `NOT_ASSIGNEE` |
| Move / transition (`item.transition`) | own | ✓ | ✓ | – | `NOT_ASSIGNEE`; then workflow rules ([04](04-workflow-rules.md)) |
| Approve: enter protected stage | – | ✓ | ✓ | – | `APPROVAL_ROLE_REQUIRED`, `SELF_APPROVAL_FORBIDDEN` |
| Use a `lead_only` transition (reject, reopen) | – | ✓ | ✓ | – | `LEAD_OR_MANAGER_REQUIRED` |
| Assign / reassign (`item.assign`) | – | ✓ | ✓ | – | `LEAD_OR_MANAGER_REQUIRED` |
| Change priority (`item.edit_priority`) | – | ✓ | ✓ | – | `LEAD_OR_MANAGER_REQUIRED` |
| Set next action (`item.edit_next_action`) | own | ✓ | ✓ | – | `NOT_ASSIGNEE` |
| Edit title, description, type, due date (`item.edit_details`) | – | – | ✓ | – | `NOT_PROJECT_MANAGER` |
| Delete / restore item (`item.delete`, `item.restore`) | – | – | ✓ | – | `NOT_PROJECT_MANAGER` |
| Add note (`item.comment`) | ✓ | ✓ | ✓ | – | |
| Add / remove blocked-by link (`item.link`) | ✓ | ✓ | ✓ | – | |
| Edit canvas drawing elements (`canvas.edit`) | ✓ | ✓ | ✓ | – | |
| Workflow structure: add stage/transition, rename, delete unflagged (`workflow.edit_structure`) | ✓ | ✓ | ✓ | – | + invariants |
| Workflow rules: kinds, protection, flags (`workflow.edit_rules`) | – | ✓ | ✓ | – | `LEAD_OR_MANAGER_REQUIRED` |
| Edit project health / status note (`project.edit_status`) | – | ✓ | ✓ | – | `LEAD_OR_MANAGER_REQUIRED` |
| Edit project name / goal (`project.edit_details`) | – | – | ✓ | ✓ | `NOT_PROJECT_MANAGER` |
| Add / remove members, change roles (`project.manage_members`) | – | – | ✓ | ✓ | `NOT_PROJECT_MANAGER` |
| Create team / project / user, assign Manager (`admin.*`) | – | – | – | ✓ | `ADMIN_REQUIRED` |
| View & retry failed jobs (`admin.jobs`) | – | – | – | ✓ | `ADMIN_REQUIRED` |
| View a person's profile | if they share a project | | | ✓ | else 404 |
| Ask the assistant | ✓ | ✓ | ✓ | ✓ | Its tools run as the caller, so it sees exactly the rows above ([13](13-assistant.md)) |

"own" = the caller is the item's current assignee. An Admin who is also a project member gets the
union of both.

People profiles show only memberships, activity and stats from projects the **viewer** is a member
of (Admins see all). Your own profile shows everything about you.

## 6.4 How the frontend uses permissions

The server computes permissions; the frontend only displays them.

* `GET /api/me` returns memberships with roles.
* Every item and project response includes `permissions: string[]` (e.g.
  `["item.comment","item.claim"]`); items also include `allowedTransitions` and
  `blockedTransitions` (with reasons), computed by the same rules as `checkTransition`.
* Buttons and the stage dropdown are shown/enabled from those arrays. On the canvas, which stages
  light up as drop targets is a client-side hint (`moveTargets()` in `canvas/context.ts`) that
  mirrors the same rules. All of these are conveniences; the server repeats every check.
* Error codes map to messages, e.g. `NOT_PROJECT_MANAGER` → pop-up "Only the Project Manager can
  delete items."

## 6.5 Tests

See [11](11-test-plan.md) §A5: non-member gets 404 on read, write, list and search; Member gets
specific 403s for delete, approve, reassign, edit details; removed member's existing session gets 404
on the next request; inactive user gets 401; Admin sees project metadata but 404 on items; CSRF
header required.
