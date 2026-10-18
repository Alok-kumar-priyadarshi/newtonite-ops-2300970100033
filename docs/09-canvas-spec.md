# 9. Canvas Spec

Each project has one shared, Excalidraw-style canvas at `/projects/:projectId/canvas`. Only project
members can open it. Every member can edit it.

## 9.1 Principle

> The canvas is a **view and editor of real data**. Every gesture calls the same API as the rest of
> the app; there is no "save canvas" that could overwrite other people's work.

| Layer | Elements | Backed by | Rules |
|---|---|---|---|
| **Workflow layer** | Project node, stage frames, connections, item cards, worker nodes | `projects`, `workflow_stages`, `workflow_transitions`, `work_items`, `users` | Workflow rules, permissions and invariants ([04](04-workflow-rules.md)) |
| **Drawing layer** | Rectangle, ellipse, diamond, text, sticky note, arrow, freehand | `canvas_elements` | Per-element version; any member |

## 9.2 Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Vendor Payments  PAY  7f3c9a2e-…  [Canvas | List]      [✨ Ask] 👀(AV) You: Lead [👥 Team (3)]│
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ ↖ ▭ ◯ ◇ T 🗒 ✎ ＋▤ │ ＋ Item ┐                                                          │
│                                                                                          │
│  ┌─ PROJECT ───────────────────────────┐        🗒 "Bank cut-off is 5pm,                 │
│  │ Vendor Payments          At risk    │            batch reversals"  — MP              │
│  │ Goal: Clear Q4 exceptions by 31 Dec │                                                 │
│  │ Now:  Waiting on bank for 3 items   │                                                 │
│  │ (AV) Manager · (RS) Lead            │                                                 │
│  │ 59 open · 5 need approval · 2 ⛓ · 1 ⏰│                                                 │
│  └─────────────────────────────────────┘                                                 │
│                                                                                          │
│  ┌ OPEN 34 START ┐   Request   ┌ IN PROGRESS 12 ┐  🔒 Approve  ┌ 🔒 APPROVED 8 DONE ┐       │
│  │ [card]        │──approval──▶│ [card]         │─────────────▶│ [card]             │──▶ …  │
│  │ [card]        │             │ [card]         │              │                    │       │
│  │ +32 more →    │             │ +10 more →     │              │                    │       │
│  └───────────────┘             └───────┬────────┘              └─────────┬──────────┘       │
│                                        ▲ ─ ─ ─ ─ Reject (R L) ─ ─ ─ ─ ─ ┘     ┌ minimap ┐ │
│  [+] [−] [fit]                                                               │ ▢▢▢▢▢  │ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

## 9.3 Elements

### Project node (one per project, movable and resizable)
Name, health chip, goal, "Now" status note, Manager and Lead avatars, counts (open, awaiting
approval, blocked, overdue), "updated by … ago". Double-click opens an editor: health/status for
Leads and the Manager, name/goal for the Manager (saved with the project `version`).

### Stage frame
A titled container for one workflow stage: name, item count, 🔒 if protected, kind badge (START /
DONE), and warnings ("Not connected yet", "No way out of this stage yet"). Cards stack inside,
sorted by priority then due date; the top 20 are shown, then "+N more →" opens the list filtered to
that stage. Frames are moved by their title bar and resized from the corners (any member).
Clicking the title bar opens the **Stage panel**: rename (any member); kind and 🔒 protection
(Lead/Manager); delete.

### Connection
An arrow from one stage frame to another = a workflow transition. The label shows the transition
label and flags: `R` (reason required), `L` (Lead/Manager only); arrows into a 🔒 stage are amber and
bold. Backward connections (to a stage further left) are dashed and routed underneath. Clicking a
connection opens the **Connection panel**: label, R and L flags (Lead/Manager), **＋ Insert a step
here**, delete.

### Item card (inside a stage frame)

```
┌──────────────────────────────────────────┐
│ 💳 PAY-4790                    ⏰  [P1]   │  type, key, overdue, priority
│ ACME vendor charged twice                │  what it is
│ "Bank shows two $4,200 debits for…"      │  why it exists (description excerpt)
│ ➡ Confirm reversal with bank             │  what needs attention next
│ ⛓ Blocked   ✋ Needs approval             │
│ ┌──────────────────────────────────────┐ │
│ │ (MP) Meera Pillai           388 open │ │  worker node: who is responsible,
│ │      Finance Analyst · Member        │ │  job title · project role, workload
│ └──────────────────────────────────────┘ │
│ 🕘 Ravi changed priority P3 → P1 · 2h ago │  what happened last
│ 💬 4                                     │  notes
└──────────────────────────────────────────┘
```

Unassigned cards show `(＋) Unassigned [Claim]`. Clicking a card opens item detail as a side panel;
clicking the worker node opens `/people/:userId`. A card whose version changed (someone else moved
or edited it) pulses green for 2 s.

### Drawing elements
Rectangle, ellipse, diamond (each with optional text), text, sticky note, arrow between any two
elements (`props.startId/endId`), freehand stroke (points relative to its box, near-duplicate
points dropped while drawing). Text in shapes, text and stickies is edited by double-click and
saved on blur.

## 9.4 Tools and shortcuts

| Tool | Key | How |
|---|---|---|
| Select | V | Click to select, drag to move, corners to resize; Shift + drag to box-select several |
| Rectangle / Ellipse / Diamond | R / O / D | Click on the canvas to place |
| Text / Sticky note | T / N | Click to place, double-click to type |
| Pen (freehand) | P | Draw with the pointer |
| ＋ Stage | S | Click to place; asks for a name (`workflow.edit_structure`) |
| ＋ Item | I | Opens the create-item form; the card appears in the start stage |
| Connect / arrow | – | Hover a frame or shape: dots appear on its edges. Drag from a dot to another element: between two **stage frames** this creates a workflow connection; otherwise a drawing arrow |
| Delete | Delete / Backspace | Drawing elements and arrows are deleted at once; stages and connections ask for confirmation and go through the workflow endpoints |
| Pan / zoom | drag empty space / mouse wheel; `+` `−` `fit` buttons | — |
| Cancel tool | Esc | Back to Select |

## 9.5 Zoom levels

| Zoom | Shown |
|---|---|
| < 45 % | Stage frames with counts and the avatars of people working there; no cards. Project node shows only its title below 35 % |
| 45–80 % | Compact cards: type, key, title, priority, owner avatar, ⛓/✋ |
| > 80 % | Full cards with worker nodes |

Nodes re-render only when the zoom crosses one of these levels, not on every zoom step.

## 9.6 Gestures → API

| Gesture | API | Who | Possible rejections |
|---|---|---|---|
| Drag a card onto another stage | `POST /items/:id/transition` | Member (own), Lead, Manager | Workflow rules, version, blockers |
| Click Claim on a card | `POST /items/:id/claim` | Any member | `ALREADY_CLAIMED` |
| Draw / move / resize / edit text of drawing elements, move/resize frames and the project node | `POST` / `PATCH /canvas/elements` | Any member | `ELEMENT_CONFLICT` |
| Delete drawing elements | `POST /canvas/elements/delete` | Any member | `ELEMENT_CONFLICT` |
| Add stage (tool or "insert a step") | `POST /workflow/stages` | Any member (kind/protection: Lead/Manager) | `WORKFLOW_INVALID`, `STAGE_NAME_TAKEN` |
| Connect two stages | `POST /workflow/transitions` | Any member (flags: Lead/Manager) | `WORKFLOW_INVALID` (`APPROVAL_BYPASS`, …) |
| Rename stage; toggle 🔒, R, L, stage kind | `PATCH` stage / transition | Rename: any member; rules: Lead, Manager | `LEAD_OR_MANAGER_REQUIRED`, `VERSION_CONFLICT` |
| Delete stage / connection | `DELETE` stage / transition | Any member for unflagged, Lead/Manager for flagged or protected | `STAGE_NOT_EMPTY`, `WORKFLOW_INVALID` |
| Edit project node | `PATCH /projects/:id` | Lead/Manager (status), Manager (name/goal) | `VERSION_CONFLICT` |

While a card is dragged, stages it can be dropped on are highlighted green and the others dimmed.
This is a client-side hint (`moveTargets()` in `canvas/context.ts`, mirroring the server rules); the
server decides. Blockers ("blocked by") are added from item detail, not drawn on the canvas.

## 9.7 Sync and conflict model

**Load:** `GET /api/projects/:id/canvas` returns everything needed in one request (project,
workflow, drawing elements, top 20 cards per stage with counts, members).

**Save timing:** an edit is sent when the gesture ends (drag stop, resize end, text blur), never on
every mouse move. A multi-select move is one batch.

**Ordered saves and pending edits** (`canvas/sync.ts`): every canvas write goes through one queue, so
two quick edits of the same element are sent in order and the second uses the version the first
returned; we never conflict with ourselves. While an element has a request in flight it is
"pending", and polling never overwrites it.

**Polling merge** (`GET /changes?since` every 3 s, every 1 s while changes keep arriving, and right
after the user's own writes): drawing elements replace the cached copy only if their version is
higher and they are not pending; deleted ones are removed. Changed cards are patched into their new
stage in place (`applyItemChanges()`, sorted like the server, top 20 kept) with the server's stage
counts; only workflow or project changes trigger a full canvas reload, plus one every minute.
A toast names who moved what ("Ravi Sharma moved PAY-4790 → Approved").

**Conflicts:**

| Situation | Result |
|---|---|
| Two members edit different elements | Both succeed |
| Two members edit the same element | Second gets `ELEMENT_CONFLICT`; the element snaps to the server copy; toast "Meera Pillai changed this while you were editing it." |
| Edit an element someone deleted | `ELEMENT_CONFLICT` (deleted); the element disappears; toast "… deleted something you were editing." (it can be restored through the API) |
| Group move with one conflict | Whole batch rejected (all-or-nothing); the group returns to the server state |
| Two members add stages at the same place | Both created; not a conflict |
| Card dragged along a connection deleted a moment ago | `INVALID_TRANSITION`; card snaps back; toast "There is no connection from … to …" |
| Repeated create (retry) | Same client-generated id → existing element returned, no duplicate |

**Presence:** a heartbeat every 20 s (and when the selection changes) sends `selectedElementIds`.
Other members on the canvas appear as avatars in the header, and elements they have selected get an
outline in their avatar colour, so people can see who is working on what before they collide.

## 9.8 Notifications from the canvas

* Workflow changes (stages, connections, flags) and item actions: one notification per event.
* Drawing edits: grouped per editor per 10 minutes, e.g. "Ravi Sharma edited the Vendor Payments
  canvas (12 changes)".

## 9.9 Limits and performance

* ≤ 2,000 live elements per project; ≤ 100 elements per batch; `props` ≤ 20 KB.
* Only the top 20 cards per stage are loaded; the rest are reached through "+N more" (the list).
* React Flow renders only nodes in the viewport (`onlyRenderVisibleElements`); cards are memoized and
  the canvas context is stable, so a change re-renders only what it affects.
* The canvas route (React Flow) is code-split from the rest of the app.

## 9.10 What v1 implements

| Built | Not built (yet) |
|---|---|
| Project node (edit health/status/goal), stage frames (move, resize, rename, kind, protect, delete), connections (add by dragging between frames, labels, R/L flags, delete), insert-a-step on a connection, workflow warnings | Dependency lines drawn between cards (cards show a ⛓ badge instead) |
| Item cards with worker nodes, three zoom levels, "+N more", claim, drag-to-move through the server's rules with snap-back | Roster panel drag-to-assign (reassign from item detail instead) |
| Rectangle, ellipse, diamond, text, sticky, freehand pen, arrows between any elements; inline text editing; resize; multi-select move; delete | Undo, hand-drawn (roughjs) style, colour/style picker, canvas filters |
| Per-element versions, ordered save queue, conflict snap-back, adaptive change polling with in-place patching, presence avatars and selection outlines | Real-time push (polling is about 1 s while active) |

## 9.11 Implementation notes

* React Flow (`@xyflow/react`) with custom node types (`canvas/nodes.tsx`): `project`, `stage`,
  `shape` (rectangle/ellipse/diamond), `text`, `sticky`, `freehand`; custom edge types
  (`canvas/edges.tsx`): `transition` (workflow connection) and `arrow` (drawing).
* Item cards are plain HTML inside the stage node, not React Flow nodes. They are stacked by layout,
  never positioned or stored, so only frames, the project node and drawing elements have stored
  positions, and layout conflicts are limited to elements people actually move. Card drag-and-drop
  uses native HTML5 drag events; the card id travels in the drag data so a drop works even before
  React re-renders.
* React Flow's node state is kept in `CanvasPage` and rebuilt from the elements, preserving measured
  sizes, selection and in-progress drags.
