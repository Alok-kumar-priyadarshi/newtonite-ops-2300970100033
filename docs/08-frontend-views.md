# 8. Frontend Views

Design goal from the brief: *a coherent and responsive experience over decorative UI*. Clean light
theme (Tailwind), dense information, every state handled (loading, empty, error, conflict).

## 8.1 Routes

| Route | Screen | Who |
|---|---|---|
| `/login` | S1 Login | everyone |
| `/` | S2 Home — needs attention | signed in |
| `/items?…` | S4 List / search (all my projects) | signed in |
| `/inbox` | S6 Notifications | signed in |
| `/projects` | Projects overview | signed in (Admin: all, metadata only) |
| `/projects/:projectId/canvas` | S3 Project canvas | members |
| `/projects/:projectId/list?…` | S4 List scoped to project | members |
| `/projects/:projectId/deleted` | Deleted items | Manager |
| `/projects/:projectId/settings` | Team: every member with role, job title, open items, since (👥 Team link on the canvas and Projects page). Role changes only for the Manager and Admins | all members, Admin |
| `/items/:itemId` | S5 Item detail (full page; also opens as side panel) | members |
| `/people/:userId` | S7 Person profile | shares a project, self, Admin |
| `/admin/*` | S8 Teams, projects, users, failed jobs | Admin |

## 8.2 App shell

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ◆ Newtonite Ops   [ 🔍 Search items… (/) ]          [+ New (C)]  🔔3  (AK)▾│
├──────────────┬───────────────────────────────────────────────────────────┤
│ 🏠 Home       │                                                           │
│ ✅ My work    │                                                           │
│ 📥 Inbox  3   │                main content                               │
│ 📁 Projects   │                                                           │
│ ──────────── │                                                           │
│ FINANCE       │                                                           │
│  💳 Vendor    │                                                           │
│     Payments  │                                                           │
│ PLATFORM      │                                                           │
│  🔥 Prod      │                                                           │
│     Incidents │                                                           │
│ ──────────── │                                                           │
│ ⚙ Admin       │ ← Admins only                                             │
└──────────────┴───────────────────────────────────────────────────────────┘
```

Sidebar lists only projects the user is a member of, grouped by team. Icons: 🔥 incident,
👤 customer issue, 💳 payment, 🛡 compliance, ☑ task. Priority chips: **P1** red, **P2** orange,
**P3** grey, **P4** light grey. Avatars are initials on the user's colour.

## 8.3 Screens

### S1 Login
Email + password form. When demo mode is on, a "Sign in as…" list shows each seeded user with job
title and roles. Wrong credentials: one generic message.

### S2 Home — needs attention

```
Good morning, Ravi                                       Updated 8s ago ⟳
┌────────────────┬────────────────┬────────────────┬────────────────┐
│ Assigned to me │ Next actions   │ Awaiting my    │ Unassigned     │
│      12        │ due    4 ⚠1    │ approval   3   │ urgent     5   │
├────────────────┼────────────────┼────────────────┼────────────────┤
│ Overdue    1   │ Blocked    2   │ Forgotten  6   │                │
└────────────────┴────────────────┴────────────────┴────────────────┘
Due soon
 🔥 P1 INC-221  Checkout API 500s spike     Investigating   (KS)  in 2h
 💳 P2 PAY-4790 ACME double charge          Awaiting appr.  (MP)  today
```

Clicking a card opens S4 with `?view=…`. Polls `GET /api/dashboard` every 30 s and on focus.
Empty state (Tara): "You're not in any project yet. Ask an Admin to add you."

### S3 Project canvas
Fully specified in [09-canvas-spec.md](09-canvas-spec.md). Toggle `[Canvas | List]` in the header.

### S4 List / search

```
[🔍 refund        ] [Stage▾] [Priority▾] [Assignee▾ Me] [Type▾] [Due▾] [Sort: Updated▾]
 Key       Type P   Title                    Stage              Owner  Next action         Updated
 PAY-4790  💳   P1  ACME double charge       Awaiting approval  (MP)   Confirm w/ bank     2m
 PAY-4751  💳   P3  Q3 reconciliation        In progress        (RS)   —                   1h
 …
                       [ Load more ]   showing 50 of 1,284
```

Every filter is a URL parameter, so views can be shared and bookmarked. Typing in search is debounced
300 ms. Row click opens S5 as a side panel; `Enter` on a focused row does the same.

### S5 Item detail

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 👀 Anita Verma is also viewing this item                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ 💳 PAY · PAY-4790 · created by Meera Pillai · 3h ago               ⤢  ✕     │
│ ACME vendor charged twice for invoice INV-2231                              │
│ [● Awaiting Approval ▾]  [P1 ▾]  (MP) Meera Pillai   ⏰ Overdue 13 Oct  ⛓     │
│ [Claim] [Release] [Reassign] [Edit details]                       [Delete]  │
├───────────────────────────────────────────┬──────────────────────────────────┤
│ Description                               │ ➡ Next action                    │
│ Bank shows two debits of $4,200 …         │  "Confirm reversal with bank"    │
│                                           │   (MP) · today 4pm   [Edit]      │
│                                           │ ⛓ Blocked by                     │
│                                           │   PAY-4740 Bank API outage (Open)│
│                                           │   [+ Add blocker]                │
├───────────────────────────────────────────┴──────────────────────────────────┤
│ Timeline                                  [All | Notes | Changes]            │
│  [Note ▾] Write an update…                                     [Post]       │
│  ● (RS) Ravi (Lead) moved In Progress → Awaiting approval           10m     │
│  ⚖ (RS) Ravi: "Vendor confirmed refund, needs sign-off"            10m     │
│  ● (MP) Meera (Member) priority P3 → P1 · "Customer escalated"      2h      │
│  ● (MP) Meera created this item                                     3h      │
│                                              [ Load older ]                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

* **Stage dropdown** (in place of the stage badge): lists every stage of the workflow. Moves in
  `allowedTransitions` can be picked ("→ Approved ✓ approve", "→ In Progress (Reject) · reason
  needed"); moves in `blockedTransitions` are disabled with the reason ("someone else must approve",
  "claim it first"); stages with no connection from the current one are disabled under "Not
  connected from …". Moves needing a reason open a reason box. The server still decides.
* Priority (dropdown, Lead/Manager), Reassign (Lead/Manager), reject/reopen and delete open a small
  dialog with a mandatory reason.
* Buttons and editable fields come from the item's `permissions`: Claim (unassigned), Release
  (assignee or Lead/Manager), Reassign, Edit details (Manager). **Delete is shown to everyone**;
  non-Managers get the server's "Only the Project Manager can delete items." message.
* `⤢` opens the full page `/items/:id`; `✕` / Esc closes the side panel.
* The item refreshes every 15 s. Open forms (edit details, priority, next action, reassign) keep the
  version they were opened with and show "This item was updated while you were editing. Saving checks
  for conflicts." when a newer version arrives ([05 §5.3](05-data-flows.md)).
* A deleted item (Managers only) shows "Deleted by … · reason" and a Restore button.

### S6 Inbox

```
📥 Inbox                                         [Unread only ☐] [Mark all read]
 ● Ravi approved PAY-4702 "Refund $12k"                     5m
 ● Ravi edited the Vendor Payments canvas (12 changes)      20m
   Meera assigned PAY-4790 to you · "Ravi owns ACME"        2h
```

Clicking opens the item, or the canvas for canvas notifications. The bell shows the unread count
(polled every 15 s).

### S7 Person profile
Header (name, job title, department, employee code, email, online dot), current projects with role
and open items, role history with dates and reasons, contribution stats with period filter, paginated
activity with `[All | Decisions | Approvals]`. Every activity row shows the role held at the time:
"Approved PAY-4702 (as Lead)".

### S8 Admin
Tabs: **Teams** (create), **Projects** (create with template and Manager; see health/counts),
**Users** (create, deactivate), **Failed jobs** (type, attempts, last error, `[Retry]`).

### Team page (`/projects/:id/settings`, every member)
Every member sees the team: person (links to profile), job title, role badge, open items (links to
the list filtered to that person), and since when. The Manager and Admins additionally get role
dropdowns, Remove buttons and an "Add person" form; every change asks for a reason. Making someone
Manager turns the current Manager into a Lead; removing or demoting the only Manager is blocked
(`LAST_MANAGER`).

### S9 ✨ Ask panel (canvas and list pages)
A right-side panel: suggested questions, the conversation (kept for the browser tab), a "🔎 Looked up
…" trail per answer, and item keys in answers as buttons that open the item. Without
`GROQ_API_KEY` it explains how to switch the assistant on. See [13](13-assistant.md).

### Keyboard
`/` focuses search, `C` creates an item (outside text fields). On the canvas: `V R O D T N P S`
pick tools, `I` new item, `Esc` back to select, `Delete`/`Backspace` deletes the selection.

## 8.4 State management

| Concern | Approach |
|---|---|
| Server data | TanStack Query. Keys: `['me']`, `['dashboard']`, `['items', filters]`, `['item', id]`, `['activity', id, filter]`, `['canvas', projectId]`, `['notifications', …]`, `['unread']`, `['person', id, …]` |
| URL state | Filters, sort, search, view, open item panel (`?item=…`) |
| Local UI state | Dialogs, canvas viewport/selection/tool, pending canvas edits |
| Polling | `refetchInterval` per query (see [02 §2.7](02-architecture.md)); paused when the tab is hidden |
| Mutations | One `useSafeMutation` wrapper: generates the idempotency key per intent, applies the optimistic update, rolls back on error, maps error codes to messages, retries network failures with the **same** key (max 2) |

## 8.5 Error and feedback mapping

| Server response | UI behaviour |
|---|---|
| 400 `VALIDATION_FAILED` | Forms validate required fields and lengths before sending; anything the server still rejects is shown as a toast with its message |
| 401 | Redirect to `/login?next=…`, back to the page after sign-in |
| 403 (any code) | Roll back the optimistic change; toast with the server's message |
| 404 | Page shows "Not found or you don't have access"; actions show a toast |
| 409 `VERSION_CONFLICT` | Auto re-apply if fields don't overlap; else conflict panel |
| 409 `ALREADY_CLAIMED` | Roll back; toast "Ravi Sharma already claimed this item."; data refetched |
| 409 `ELEMENT_CONFLICT` | Canvas elements snap to the server's copy; toast naming who changed them |
| 409 / 422 workflow codes | Roll back (card snaps back); toast explains the rule ("This change would let items reach a finished stage without approval.") |
| 410 | Toast "This item was deleted by Anita Verma (duplicate)."; it disappears on the next refresh |
| Network error / 503 | Retried automatically with the same idempotency key (up to 2 times); if it still fails, toast "Connection problem — your last action was not saved." and roll back |

## 8.6 Accessibility and performance

* All actions on the canvas are also available from item detail and the list (keyboard and
  screen-reader friendly path).
* Buttons have visible focus; colour is never the only signal (priority chips include text).
* Lists render only loaded pages; no virtualisation needed at 50 rows per page.
* Code-split the canvas route (React Flow is the largest dependency).
