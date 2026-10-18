import '@xyflow/react/dist/style.css';
import type { CanvasData, CanvasElement, ChangesFeed, ItemCard, ItemDetail, Stage } from '@nops/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  ConnectionMode,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, get } from '../api/client';
import { useSafeMutation } from '../api/mutation';
import { useCanvas, useMe } from '../api/queries';
import { AssistantDrawer } from '../components/AssistantDrawer';
import { CreateItemModal } from '../components/CreateItemModal';
import { ItemDrawer } from '../components/ItemDrawer';
import { usePresence } from '../components/ItemDetailView';
import { useToast } from '../components/Toasts';
import { Avatar, ErrorState, ReasonDialog, Spinner } from '../components/ui';
import { ROLE_LABEL } from '../lib/format';
import { applyItemChanges } from './applyChanges';
import { CanvasContext, type CanvasCtx } from './context';
import { edgeTypes } from './edges';
import { nodeTypes } from './nodes';
import { NameDialog, ProjectEditDialog, StagePanel, TransitionPanel } from './panels';
import { useCanvasSync } from './sync';

type Tool = 'select' | 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'sticky' | 'freehand' | 'stage';

const TOOLS: { tool: Tool; icon: string; label: string; key: string }[] = [
  { tool: 'select', icon: '↖', label: 'Select', key: 'v' },
  { tool: 'rectangle', icon: '▭', label: 'Rectangle', key: 'r' },
  { tool: 'ellipse', icon: '◯', label: 'Ellipse', key: 'o' },
  { tool: 'diamond', icon: '◇', label: 'Diamond', key: 'd' },
  { tool: 'text', icon: 'T', label: 'Text', key: 't' },
  { tool: 'sticky', icon: '🗒', label: 'Sticky note', key: 'n' },
  { tool: 'freehand', icon: '✎', label: 'Pen', key: 'p' },
  { tool: 'stage', icon: '＋▤', label: 'Add stage', key: 's' },
];

const SIZES: Partial<Record<Tool, [number, number]>> = {
  rectangle: [180, 100],
  ellipse: [160, 110],
  diamond: [150, 120],
  text: [220, 40],
  sticky: [220, 150],
};

type Dialog =
  | { kind: 'addStage'; x: number; y: number; insertOnTransitionId?: string }
  | { kind: 'moveReason'; item: ItemCard; stage: Stage; label: string }
  | { kind: 'project' }
  | { kind: 'createItem' }
  | null;

export default function CanvasPage() {
  const { projectId } = useParams();
  const q = useCanvas(projectId!);
  if (q.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <Spinner size={28} />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="p-6">
        <ErrorState error={q.error} />
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <CanvasInner key={projectId} projectId={projectId!} data={q.data} />
    </ReactFlowProvider>
  );
}

function CanvasInner({ projectId, data }: { projectId: string; data: CanvasData }) {
  const me = useMe().data!;
  const qc = useQueryClient();
  const toast = useToast();
  const rf = useReactFlow();
  const sync = useCanvasSync(projectId);
  const role = data.project.myRole;
  const canEdit = data.project.permissions.includes('canvas.edit');
  const canEditRules = data.project.permissions.includes('workflow.edit_rules');

  const [tool, setTool] = useState<Tool>('select');
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<ItemCard | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [asking, setAsking] = useState(false);

  // ---------------------------------------------------------------- server state
  useEffect(() => {
    sync.mergeServer(data.elements);
  }, [data.elements, sync.mergeServer]);

  // Poll "what changed since" (docs/05 §5.9): every 3 s; every 1 s while changes keep arriving
  // (people are actively working); immediately after our own writes and on window focus.
  // Changed cards are patched into the cached canvas instead of reloading it.
  const since = useRef(data.serverTime);
  const seenVersions = useRef(new Map<string, number>()); // item id → last applied version
  const pollRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (data.serverTime > since.current) since.current = data.serverTime;
  }, [data.serverTime]);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(poll, ms);
    };
    const poll = async () => {
      if (busy) {
        again = true;
        return;
      }
      if (document.visibilityState !== 'visible') return schedule(3000);
      busy = true;
      let active = false;
      try {
        const feed = await get<ChangesFeed>(`/projects/${projectId}/changes?since=${encodeURIComponent(since.current)}`);
        since.current = feed.serverTime;
        // The feed overlaps the previous window by 30 s, so only versions we haven't applied count.
        const fresh = feed.items.filter((i) => seenVersions.current.get(i.id) !== i.version);
        fresh.forEach((i) => seenVersions.current.set(i.id, i.version));
        const elementsChanged = sync.mergeServer(feed.elements);
        active = fresh.length > 0 || elementsChanged;
        if (feed.resync || feed.workflow || feed.project) {
          qc.invalidateQueries({ queryKey: ['canvas', projectId] });
        } else if (fresh.length > 0) {
          announceMoves(fresh);
          qc.setQueryData<CanvasData>(['canvas', projectId], (prev) => prev && applyItemChanges(prev, fresh, feed.stageCounts));
        }
      } catch {
        /* the next poll will try again */
      } finally {
        busy = false;
      }
      if (again) {
        again = false;
        return schedule(0);
      }
      schedule(active ? 1000 : 3000);
    };
    pollRef.current = () => schedule(0);
    schedule(3000);
    const onFocus = () => schedule(0);
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  const pollNow = useCallback(() => pollRef.current(), []);

  /** "Ravi moved PAY-12 → Approved" for cards that other people moved. */
  const announceMoves = (items: ItemCard[]) => {
    const prev = qc.getQueryData<CanvasData>(['canvas', projectId]);
    if (!prev) return;
    const known = new Map(prev.stages.flatMap((s) => s.items).map((i) => [i.id, i]));
    let shown = 0;
    for (const it of items) {
      const before = known.get(it.id);
      if (!before || before.stage.id === it.stage.id || shown >= 3) continue;
      const actor = it.lastChange?.actor;
      if (actor && actor.id !== me.user.id) {
        toast('info', `${actor.fullName} moved ${it.key} → ${it.stage.name}`);
        shown++;
      }
    }
  };

  // ---------------------------------------------------------------- presence
  const selectedIds = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);
  const viewers = usePresence('canvas', projectId, selectedIds);
  // Only rebuild when someone's selection actually changed, not on every heartbeat.
  const selectionKey = viewers.map((v) => `${v.user.avatarColor}:${v.selectedElementIds.join(',')}`).join('|');
  const othersSelection = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of viewers) for (const id of v.selectedElementIds) m.set(id, v.user.avatarColor);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  // ---------------------------------------------------------------- mutations
  const invalidateCanvas = () => [['canvas', projectId], ['project', projectId], ['items'], ['dashboard'], ['projects']];
  /** After moving or claiming a card: the card is already moved locally; fetch just the changes. */
  const afterCardWrite = () => {
    pollNow();
    return [['item'], ['items'], ['dashboard'], ['projects']];
  };
  /** If the server refused, the local move was rolled back; reload so nothing stale remains. */
  const reloadOnError = () => {
    qc.invalidateQueries({ queryKey: ['canvas', projectId] });
    return false; // still show the server's message
  };

  const workflowWrite = useSafeMutation({
    fn: (v: { method: string; path: string; body?: unknown }) => api(v.method, `/projects/${projectId}/workflow${v.path}`, v.body),
    invalidate: invalidateCanvas,
  });

  /** Moves a card optimistically in the canvas cache; returns the undo. */
  const moveCardInCache = (item: ItemCard, to: Stage | null, patch: Partial<ItemCard> = {}) => {
    const prev = qc.getQueryData<CanvasData>(['canvas', projectId]);
    if (!prev) return () => {};
    qc.setQueryData<CanvasData>(['canvas', projectId], {
      ...prev,
      stages: prev.stages.map((s) => {
        const without = s.items.filter((i) => i.id !== item.id);
        if (to && s.stageId === to.id) {
          return { ...s, count: s.count + 1, items: [{ ...item, ...patch, stage: { id: to.id, name: to.name, kind: to.kind } }, ...without] };
        }
        if (s.stageId === item.stage.id) {
          return to ? { ...s, count: s.count - 1, items: without } : { ...s, items: s.items.map((i) => (i.id === item.id ? { ...i, ...patch } : i)) };
        }
        return s;
      }),
    });
    return () => qc.setQueryData(['canvas', projectId], prev);
  };

  const transition = useSafeMutation({
    fn: (v: { item: ItemCard; stage: Stage; reason?: string }, key) =>
      api<ItemDetail>('POST', `/items/${v.item.id}/transition`, { version: v.item.version, toStageId: v.stage.id, reason: v.reason }, { idempotencyKey: key }),
    optimistic: (v) => moveCardInCache(v.item, v.stage),
    invalidate: afterCardWrite,
    // The card snaps back (rollback) and the server's reason is shown, e.g. "Only a Lead can approve".
    onError: reloadOnError,
  });

  const claim = useSafeMutation({
    fn: (item: ItemCard, key) => api<ItemDetail>('POST', `/items/${item.id}/claim`, {}, { idempotencyKey: key }),
    optimistic: (item) =>
      moveCardInCache(item, null, {
        assignee: { ...me.user, designation: me.user.designation, projectRole: role, openItemCount: 0 },
      }),
    invalidate: afterCardWrite,
    onError: reloadOnError,
    successMessage: 'Claimed.',
  });

  const patchProject = useSafeMutation({
    fn: (fields: Record<string, unknown>) => api('PATCH', `/projects/${projectId}`, { version: data.project.version, ...fields }),
    invalidate: invalidateCanvas,
    onSuccess: () => setDialog(null),
    successMessage: 'Project updated.',
  });

  const dropOnStage = useCallback(
    (item: ItemCard, stage: Stage) => {
      setDragging(null);
      const t = data.workflow.transitions.find((x) => x.fromStageId === item.stage.id && x.toStageId === stage.id);
      if (t?.requiresReason) setDialog({ kind: 'moveReason', item, stage, label: t.label ?? stage.name });
      else transition.mutate({ item, stage });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.workflow],
  );

  // ---------------------------------------------------------------- nodes & edges
  const built = useMemo<Node[]>(() => {
    const stageById = new Map(data.workflow.stages.map((s) => [s.id, s]));
    const stageInfo = new Map(data.stages.map((s) => [s.stageId, s]));
    return sync.elements
      .filter((el) => el.type !== 'arrow')
      .flatMap((el): Node[] => {
        const other = othersSelection.get(el.id);
        const base = {
          id: el.id,
          position: { x: el.x, y: el.y },
          width: el.width,
          height: el.height,
          draggable: canEdit,
          className: other ? 'selected-by-other' : undefined,
          style: other ? ({ '--other-color': other } as React.CSSProperties) : undefined,
        };
        switch (el.type) {
          case 'project_node':
            return [{ ...base, type: 'project', zIndex: 0, data: { el } }];
          case 'stage_frame': {
            const stage = el.stageId ? stageById.get(el.stageId) : undefined;
            if (!stage) return [];
            const info = stageInfo.get(stage.id);
            return [
              {
                ...base,
                type: 'stage',
                zIndex: 0,
                dragHandle: '.stage-drag',
                data: {
                  el,
                  stage,
                  items: info?.items ?? [],
                  count: info?.count ?? 0,
                  warnings: data.workflow.warnings.filter((w) => w.stageId === stage.id),
                },
              },
            ];
          }
          case 'rectangle':
          case 'ellipse':
          case 'diamond':
            return [{ ...base, type: 'shape', zIndex: 2 + el.zIndex, data: { el } }];
          default:
            return [{ ...base, type: el.type, zIndex: 2 + el.zIndex, data: { el } }];
        }
      });
  }, [sync.elements, data.workflow, data.stages, othersSelection, canEdit]);

  // Keep React Flow's measured sizes, selection and in-progress drags when rebuilding.
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return built.map((n) => {
        const p = prevById.get(n.id);
        if (!p) return n;
        return { ...n, selected: p.selected, measured: p.measured, ...(p.dragging ? { position: p.position, dragging: true } : {}) };
      });
    });
  }, [built]);

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);

  const edges = useMemo<Edge[]>(() => {
    const frameByStage = new Map(sync.elements.filter((e) => e.type === 'stage_frame').map((e) => [e.stageId!, e]));
    const stageById = new Map(data.workflow.stages.map((s) => [s.id, s]));
    const ids = new Set(sync.elements.map((e) => e.id));
    const result: Edge[] = [];
    for (const t of data.workflow.transitions) {
      const from = frameByStage.get(t.fromStageId);
      const to = frameByStage.get(t.toStageId);
      if (!from || !to) continue;
      const backward = to.x < from.x;
      const protectedTarget = !!stageById.get(t.toStageId)?.requiresApproval;
      const id = `t:${t.id}`;
      result.push({
        id,
        source: from.id,
        target: to.id,
        sourceHandle: backward ? 'bs' : 'r',
        targetHandle: backward ? 'bt' : 'l',
        type: 'transition',
        selected: selectedEdgeId === id,
        markerEnd: { type: MarkerType.ArrowClosed, color: protectedTarget ? '#d97706' : backward ? '#94a3b8' : '#475569' },
        data: { transition: t, protectedTarget, backward },
      });
    }
    for (const el of sync.elements) {
      if (el.type !== 'arrow' || !ids.has(el.props.startId) || !ids.has(el.props.endId)) continue;
      result.push({
        id: el.id,
        source: el.props.startId,
        target: el.props.endId,
        sourceHandle: 'r',
        targetHandle: 'l',
        type: 'arrow',
        selected: selectedEdgeId === el.id,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' },
      });
    }
    return result;
  }, [sync.elements, data.workflow, selectedEdgeId]);

  // ---------------------------------------------------------------- gestures
  const elementById = useMemo(() => new Map(sync.elements.map((e) => [e.id, e])), [sync.elements]);

  const onNodeDragStop = useCallback(
    (_e: unknown, _n: Node, dragged: Node[]) => {
      sync.save(dragged.map((n) => ({ id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })));
    },
    [sync],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!canEdit || c.source === c.target) return;
      const a = elementById.get(c.source);
      const b = elementById.get(c.target);
      if (!a || !b) return;
      if (a.type === 'stage_frame' && b.type === 'stage_frame') {
        // Connecting two stages = a new allowed move (validated by the server's workflow rules).
        workflowWrite.mutate({
          method: 'POST',
          path: '/transitions',
          body: { id: crypto.randomUUID(), fromStageId: a.stageId, toStageId: b.stageId },
        });
      } else {
        sync.create([{ id: crypto.randomUUID(), type: 'arrow', x: 0, y: 0, width: 0, height: 0, zIndex: 0, props: { startId: a.id, endId: b.id } }]);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [elementById, canEdit],
  );

  const deleteStage = (stage: Stage) => {
    if (confirm(`Delete stage "${stage.name}"? Its connections are removed too.`)) {
      workflowWrite.mutate({ method: 'DELETE', path: `/stages/${stage.id}` });
    }
  };
  const deleteTransition = (transitionId: string) => {
    if (confirm('Delete this connection? Items will no longer be able to make this move.')) {
      workflowWrite.mutate({ method: 'DELETE', path: `/transitions/${transitionId}` });
      setSelectedEdgeId(null);
    }
  };

  /** We handle deletes ourselves (with versions), so React Flow never removes anything on its own. */
  const onBeforeDelete = useCallback(
    async ({ nodes: ns, edges: es }: { nodes: Node[]; edges: Edge[] }) => {
      if (!canEdit) return false;
      const drawing = ns.filter((n) => !['stage', 'project'].includes(n.type ?? '')).map((n) => n.id);
      const arrows = es.filter((e) => e.type === 'arrow').map((e) => e.id);
      if (drawing.length || arrows.length) {
        const removed = [...drawing, ...arrows];
        sync.remove(removed);
        toast('info', `Deleted ${removed.length} element${removed.length > 1 ? 's' : ''}.`);
      }
      const stageNode = ns.find((n) => n.type === 'stage');
      if (stageNode) deleteStage((stageNode.data as { stage: Stage }).stage);
      const tEdge = es.find((e) => e.type === 'transition');
      if (!stageNode && tEdge) deleteTransition((tEdge.data as { transition: { id: string } }).transition.id);
      if (ns.some((n) => n.type === 'project')) toast('info', 'The project node cannot be deleted.');
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit, sync],
  );

  const onPaneClick = useCallback(
    (e: React.MouseEvent) => {
      setSelectedEdgeId(null);
      if (!canEdit || tool === 'select' || tool === 'freehand') return;
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (tool === 'stage') {
        setDialog({ kind: 'addStage', x: Math.round(p.x), y: Math.round(p.y) });
      } else {
        const [w, h] = SIZES[tool]!;
        sync.create([
          {
            id: crypto.randomUUID(),
            type: tool,
            x: Math.round(p.x - w / 2),
            y: Math.round(p.y - h / 2),
            width: w,
            height: h,
            zIndex: 0,
            props: tool === 'sticky' ? { text: '', color: 'yellow' } : { text: tool === 'text' ? 'Text' : '' },
          },
        ]);
      }
      setTool('select');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, canEdit, rf],
  );

  // Keyboard shortcuts for tools (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') setTool('select');
      if (e.key.toLowerCase() === 'i' && canEdit) {
        e.preventDefault();
        setDialog({ kind: 'createItem' });
      }
      const match = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (match && canEdit) {
        e.preventDefault();
        e.stopPropagation();
        setTool(match.tool);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [canEdit]);

  // ---------------------------------------------------------------- selection panels
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedStage = selectedNodes.length === 1 && selectedNodes[0].type === 'stage' ? (selectedNodes[0].data as { stage: Stage }).stage : null;
  const selectedTransition = selectedEdgeId?.startsWith('t:') ? data.workflow.transitions.find((t) => `t:${t.id}` === selectedEdgeId) : undefined;
  const stageName = (id: string) => data.workflow.stages.find((s) => s.id === id)?.name ?? '?';

  const insertOnTransition = (transitionId: string) => {
    const t = data.workflow.transitions.find((x) => x.id === transitionId)!;
    const frames = sync.elements.filter((e) => e.type === 'stage_frame');
    const a = frames.find((f) => f.stageId === t.fromStageId);
    const b = frames.find((f) => f.stageId === t.toStageId);
    const x = a && b ? Math.round((a.x + b.x) / 2) : 0;
    const y = a ? Math.round(a.y + a.height + 80) : 0;
    setDialog({ kind: 'addStage', x, y, insertOnTransitionId: transitionId });
  };

  // A stable context value: stage frames and cards re-render only when something they show changes,
  // not on every render of this page (e.g. each mouse move while dragging a node).
  const claimMutate = claim.mutate;
  const claimCard = useCallback((item: ItemCard) => claimMutate(item), [claimMutate]);
  const editProject = useCallback(() => setDialog({ kind: 'project' }), []);
  const ctx = useMemo<CanvasCtx>(
    () => ({
      data,
      meId: me.user.id,
      role,
      canEdit,
      save: sync.save,
      openItem: setOpenItemId,
      claim: claimCard,
      dropOnStage,
      dragging,
      setDragging,
      editProject,
      othersSelection,
    }),
    [data, me.user.id, role, canEdit, sync.save, claimCard, dropOnStage, dragging, editProject, othersSelection],
  );

  return (
    <CanvasContext.Provider value={ctx}>
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-semibold">{data.project.name}</h1>
              <span className="rounded bg-slate-100 px-1.5 font-mono text-xs text-slate-600">{data.project.key}</span>
              <span className="hidden font-mono text-[11px] text-slate-400 lg:inline" title="Project UUID">{data.project.id}</span>
            </div>
          </div>
          <div className="flex rounded-md ring-1 ring-slate-300">
            <span className="rounded-l-md bg-slate-800 px-3 py-1 text-sm text-white">Canvas</span>
            <Link to={`/projects/${projectId}/list`} className="rounded-r-md px-3 py-1 text-sm text-slate-600 hover:bg-slate-50">List</Link>
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <button
              className="rounded-md bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-700"
              onClick={() => setAsking(true)}
              title="Ask questions about this project's work"
            >
              ✨ Ask
            </button>
            {viewers.length > 0 && (
              <span className="flex items-center gap-1" title={`${viewers.map((v) => v.user.fullName).join(', ')} on this canvas`}>
                👀 {viewers.map((v) => <Avatar key={v.user.id} user={v.user} size={24} />)}
              </span>
            )}
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">You: {role ? ROLE_LABEL[role] : 'Viewer'}</span>
            <Link
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-brand-700 ring-1 ring-slate-200 hover:bg-slate-50"
              to={`/projects/${projectId}/settings`}
              title="Everyone in this project and their role"
            >
              👥 Team ({data.members.length})
            </Link>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {canEdit && (
            <div className="absolute left-3 top-3 z-10 flex items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-1 shadow-md">
              {TOOLS.map((t) => (
                <button
                  key={t.tool}
                  title={`${t.label} (${t.key.toUpperCase()})`}
                  aria-label={t.label}
                  aria-pressed={tool === t.tool}
                  onClick={() => setTool(t.tool)}
                  className={`h-8 min-w-8 rounded-lg px-1.5 text-sm ${tool === t.tool ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
                >
                  {t.icon}
                </button>
              ))}
              <span className="mx-1 h-6 w-px bg-slate-200" />
              <button className="h-8 rounded-lg px-2 text-sm text-slate-700 hover:bg-slate-100" title="New item (I)" onClick={() => setDialog({ kind: 'createItem' })}>
                ＋ Item
              </button>
            </div>
          )}
          {tool !== 'select' && tool !== 'freehand' && (
            <div className="pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2 rounded-full bg-slate-800 px-3 py-1 text-xs text-white">
              Click on the canvas to place · Esc to cancel
            </div>
          )}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onBeforeDelete={onBeforeDelete}
            onPaneClick={onPaneClick}
            onEdgeClick={(_e, edge) => setSelectedEdgeId(edge.id)}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={canEdit ? ['Delete', 'Backspace'] : null}
            nodesConnectable={canEdit}
            minZoom={0.1}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.08 }}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
            className={tool !== 'select' ? 'cursor-crosshair' : undefined}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#cbd5e1" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeStrokeWidth={3} className="!bg-white" />
          </ReactFlow>

          {tool === 'freehand' && <FreehandOverlay onDone={(el) => { sync.create([el]); }} />}

          {selectedStage && canEdit && (
            <StagePanel
              stage={selectedStage}
              canEditRules={canEditRules}
              onClose={() => setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))}
              onRename={(name) => workflowWrite.mutate({ method: 'PATCH', path: `/stages/${selectedStage.id}`, body: { version: selectedStage.version, name } })}
              onPatch={(p) => workflowWrite.mutate({ method: 'PATCH', path: `/stages/${selectedStage.id}`, body: { version: selectedStage.version, ...p } })}
              onDelete={() => deleteStage(selectedStage)}
            />
          )}
          {!selectedStage && selectedTransition && canEdit && (
            <TransitionPanel
              transition={selectedTransition}
              fromName={stageName(selectedTransition.fromStageId)}
              toName={stageName(selectedTransition.toStageId)}
              canEditRules={canEditRules}
              onClose={() => setSelectedEdgeId(null)}
              onPatch={(p) =>
                workflowWrite.mutate({ method: 'PATCH', path: `/transitions/${selectedTransition.id}`, body: { version: selectedTransition.version, ...p } })
              }
              onInsert={() => insertOnTransition(selectedTransition.id)}
              onDelete={() => deleteTransition(selectedTransition.id)}
            />
          )}
        </div>
      </div>

      {asking && <AssistantDrawer projectId={projectId} onOpenItem={setOpenItemId} onClose={() => setAsking(false)} />}
      {openItemId && (
        <ItemDrawer
          itemId={openItemId}
          onClose={() => {
            setOpenItemId(null);
            pollNow(); // pick up anything changed in the drawer without reloading the canvas
          }}
        />
      )}
      {dialog?.kind === 'addStage' && (
        <NameDialog
          title={dialog.insertOnTransitionId ? 'Insert a step' : 'New stage'}
          onClose={() => setDialog(null)}
          onSubmit={(name) => {
            workflowWrite.mutate({
              method: 'POST',
              path: '/stages',
              body: {
                id: crypto.randomUUID(),
                name,
                frame: { x: dialog.x, y: dialog.y, width: 340, height: 640 },
                insertOnTransitionId: dialog.insertOnTransitionId,
              },
            });
            setDialog(null);
            setSelectedEdgeId(null);
          }}
        />
      )}
      {dialog?.kind === 'moveReason' && (
        <ReasonDialog
          title={`${dialog.label}: ${dialog.item.key} → ${dialog.stage.name}`}
          confirmLabel={dialog.label}
          busy={transition.isPending}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => {
            transition.mutate({ item: dialog.item, stage: dialog.stage, reason });
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'project' && (
        <ProjectEditDialog project={data.project} busy={patchProject.isPending} onClose={() => setDialog(null)} onSave={(f) => patchProject.mutate(f)} />
      )}
      {dialog?.kind === 'createItem' && <CreateItemModal defaultProjectId={projectId} onClose={() => setDialog(null)} />}
    </CanvasContext.Provider>
  );
}

/** Pen tool: captures the pointer over the canvas and saves the stroke as one freehand element. */
function FreehandOverlay({ onDone }: { onDone: (el: Omit<CanvasElement, 'projectId' | 'version' | 'updatedBy' | 'updatedAt' | 'stageId'>) => void }) {
  const rf = useReactFlow();
  const [screen, setScreen] = useState<[number, number][]>([]);
  const flow = useRef<[number, number][]>([]);
  const box = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);

  const add = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const last = flow.current[flow.current.length - 1];
    if (last && Math.hypot(p.x - last[0], p.y - last[1]) < 2) return;
    flow.current.push([p.x, p.y]);
    setScreen((s) => [...s, [e.clientX - r.left, e.clientY - r.top]]);
  };

  return (
    <div
      ref={box}
      className="absolute inset-0 z-[5] cursor-crosshair"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drawing.current = true;
        flow.current = [];
        setScreen([]);
        add(e);
      }}
      onPointerMove={(e) => drawing.current && add(e)}
      onPointerUp={() => {
        drawing.current = false;
        const pts = flow.current;
        setScreen([]);
        if (pts.length < 2) return;
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const w = Math.max(4, Math.max(...xs) - minX);
        const h = Math.max(4, Math.max(...ys) - minY);
        onDone({
          id: crypto.randomUUID(),
          type: 'freehand',
          x: Math.round(minX),
          y: Math.round(minY),
          width: Math.round(w),
          height: Math.round(h),
          zIndex: 0,
          props: { points: pts.map(([x, y]) => [Math.round(x - minX), Math.round(y - minY)]), w: Math.round(w), h: Math.round(h) },
        });
      }}
    >
      <svg className="pointer-events-none h-full w-full">
        <polyline points={screen.map((p) => p.join(',')).join(' ')} fill="none" stroke="#334155" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
