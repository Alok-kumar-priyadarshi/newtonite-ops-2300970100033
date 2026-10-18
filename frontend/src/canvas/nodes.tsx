import type { CanvasElement, ItemCard, Stage, WorkflowWarning } from '@nops/shared';
import { Handle, type Node, type NodeProps, NodeResizer, Position, useStore } from '@xyflow/react';
import { memo, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar, PriorityChip } from '../components/ui';
import { HEALTH_META, ROLE_LABEL, timeAgo, TYPE_META } from '../lib/format';
import { moveTargets, useCanvasCtx } from './context';

// Zoom expressed as detail levels, so nodes re-render only when a level changes, not on every
// tiny zoom step: 0 = far (avatars only), 1 = medium (compact cards), 2 = close (full cards).
type Transform = { transform: [number, number, number] };
const detailLevel = (s: Transform) => (s.transform[2] < 0.45 ? 0 : s.transform[2] < 0.8 ? 1 : 2);
const projectDetailVisible = (s: Transform) => s.transform[2] > 0.35;
const CARD_MIME = 'application/x-nops-item';

/** Connection points on every node. With ConnectionMode.Loose any handle can join any other. */
function Handles() {
  const cls = '!h-2.5 !w-2.5 !border-2 !border-white !bg-slate-400 opacity-0 group-hover:opacity-100';
  return (
    <>
      <Handle type="target" position={Position.Left} id="l" className={cls} />
      <Handle type="source" position={Position.Right} id="r" className={cls} />
      <Handle type="target" position={Position.Bottom} id="bt" className={cls} style={{ left: '35%' }} />
      <Handle type="source" position={Position.Bottom} id="bs" className={cls} style={{ left: '65%' }} />
    </>
  );
}

function Resizer({ selected, el, minWidth = 40, minHeight = 30 }: { selected: boolean; el: CanvasElement; minWidth?: number; minHeight?: number }) {
  const { save, canEdit } = useCanvasCtx();
  return (
    <NodeResizer
      isVisible={selected && canEdit}
      minWidth={minWidth}
      minHeight={minHeight}
      lineClassName="!border-brand-500"
      handleClassName="!h-2 !w-2 !border-brand-500 !bg-white"
      onResizeEnd={(_e, p) => save([{ id: el.id, x: p.x, y: p.y, width: p.width, height: p.height }])}
    />
  );
}

/** Double-click to edit; saves props.text on blur. */
function EditableText({ el, className, placeholder }: { el: CanvasElement; className?: string; placeholder?: string }) {
  const { save, canEdit } = useCanvasCtx();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string>(el.props.text ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setValue(el.props.text ?? '');
  }, [el.props.text, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  if (editing) {
    return (
      <textarea
        ref={ref}
        className={`nodrag nowheel h-full w-full resize-none bg-transparent outline-none ${className ?? ''}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (value !== (el.props.text ?? '')) save([{ id: el.id, props: { ...el.props, text: value } }]);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
          e.stopPropagation();
        }}
      />
    );
  }
  return (
    <div className={`h-full w-full whitespace-pre-wrap break-words ${className ?? ''}`} onDoubleClick={() => canEdit && setEditing(true)}>
      {el.props.text || <span className="opacity-40">{placeholder}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ project node

export type ProjectNodeType = Node<{ el: CanvasElement }, 'project'>;
export const ProjectNode = memo(function ProjectNode({ data, selected }: NodeProps<ProjectNodeType>) {
  const { data: canvas, editProject } = useCanvasCtx();
  const p = canvas.project;
  const showDetail = useStore(projectDetailVisible);
  return (
    <div className="group h-full w-full overflow-hidden rounded-xl border-2 border-slate-800 bg-white shadow-sm" onDoubleClick={editProject}>
      <Resizer selected={selected} el={data.el} minWidth={300} minHeight={160} />
      <Handles />
      <div className="flex items-center gap-2 bg-slate-800 px-4 py-2 text-white">
        <span className="text-xs font-semibold uppercase tracking-wider opacity-70">Project</span>
        <span className="font-semibold">{p.name}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-semibold ${HEALTH_META[p.health].className}`}>{HEALTH_META[p.health].label}</span>
      </div>
      {showDetail && (
        <div className="space-y-1.5 px-4 py-3 text-sm">
          <div><span className="text-slate-500">Goal:</span> {p.goal || '—'}</div>
          <div><span className="text-slate-500">Now:</span> {p.statusNote || '—'}</div>
          <div className="flex items-center gap-2">
            <Avatar user={p.manager} size={22} link /> <span className="text-slate-600">Manager</span>
            {p.leads.map((l) => <Avatar key={l.id} user={l} size={22} link />)} {p.leads.length > 0 && <span className="text-slate-600">Lead</span>}
          </div>
          <div className="flex gap-3 text-xs">
            <span><strong>{p.counts.open}</strong> open</span>
            <span className="text-amber-700"><strong>{p.counts.awaitingApproval}</strong> need approval</span>
            <span className="text-red-700"><strong>{p.counts.blocked}</strong> ⛓</span>
            <span className="text-red-700"><strong>{p.counts.overdue}</strong> ⏰</span>
          </div>
          <div className="text-xs text-slate-400">
            Updated {p.updatedBy ? `by ${p.updatedBy.fullName} ` : ''}{timeAgo(p.updatedAt)} · double-click to edit
          </div>
        </div>
      )}
    </div>
  );
});

// ------------------------------------------------------------------ stage frame + cards

export type StageNodeType = Node<{ el: CanvasElement; stage: Stage; items: ItemCard[]; count: number; warnings: WorkflowWarning[] }, 'stage'>;

const WARNING_TEXT: Record<string, string> = {
  DEAD_END: 'No way out of this stage yet',
  DETACHED_STAGE: 'Not connected yet',
  UNREACHABLE_STAGE: 'Items cannot reach this stage',
};

export const StageNode = memo(function StageNode({ data, selected }: NodeProps<StageNodeType>) {
  const ctx = useCanvasCtx();
  const navigate = useNavigate();
  const level = useStore(detailLevel);
  const { stage, items, count } = data;
  const dragging = ctx.dragging;
  const allowed = dragging ? moveTargets(ctx.data.workflow, dragging, ctx.meId, ctx.role).has(stage.id) : false;
  const isSource = dragging?.stage.id === stage.id;
  const [over, setOver] = useState(false);
  const ring = dragging
    ? allowed
      ? over
        ? 'border-emerald-500 ring-4 ring-emerald-200'
        : 'border-emerald-400'
      : isSource
        ? 'border-slate-300'
        : 'border-slate-200 opacity-50'
    : stage.requiresApproval
      ? 'border-amber-400'
      : 'border-slate-300';
  const done = stage.kind === 'done';

  return (
    <div
      className={`group flex h-full w-full flex-col overflow-hidden rounded-xl border-2 bg-slate-50/95 shadow-sm transition ${ring}`}
      // The card id travels in the drag data, so the drop works even before React re-renders
      // with the `dragging` state (which is only used for highlighting).
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(CARD_MIME)) return;
        e.preventDefault(); // allow the drop; the server makes the real decision
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(CARD_MIME);
        if (!id) return;
        e.preventDefault();
        setOver(false);
        const card = ctx.data.stages.flatMap((s) => s.items).find((i) => i.id === id);
        if (card && card.stage.id !== stage.id) ctx.dropOnStage(card, stage);
      }}
    >
      <Resizer selected={selected} el={data.el} minWidth={220} minHeight={160} />
      <Handles />
      <div className={`stage-drag flex cursor-grab items-center gap-2 px-3 py-2 ${done ? 'bg-emerald-50' : stage.kind === 'start' ? 'bg-slate-100' : 'bg-white'} border-b border-slate-200`}>
        {stage.requiresApproval && <span title="Protected: entering this stage is an approval">🔒</span>}
        <span className="font-semibold uppercase tracking-wide text-slate-700" style={{ fontSize: 13 }}>{stage.name}</span>
        <span className="rounded-full bg-slate-200 px-2 text-xs font-semibold text-slate-700">{count}</span>
        {stage.kind !== 'active' && <span className="text-[10px] uppercase text-slate-400">{stage.kind}</span>}
        {data.warnings.map((w) => (
          <span key={w.code} className="ml-auto text-xs text-amber-700" title={WARNING_TEXT[w.code]}>⚠ {WARNING_TEXT[w.code]}</span>
        ))}
      </div>
      {level === 0 ? (
        <div className="flex flex-1 flex-wrap content-start gap-1 p-3">
          {[...new Map(items.filter((i) => i.assignee).map((i) => [i.assignee!.id, i.assignee!])).values()].slice(0, 12).map((u) => (
            <Avatar key={u.id} user={u} size={28} />
          ))}
        </div>
      ) : (
        <div className="nowheel flex-1 space-y-2 overflow-y-auto p-2">
          {items.map((item) => (
            <CardView key={item.id} item={item} compact={level === 1} />
          ))}
          {count > items.length && (
            <button
              className="nodrag w-full rounded-md py-1.5 text-sm text-brand-700 hover:bg-brand-50"
              onClick={() => navigate(`/projects/${ctx.data.project.id}/list?stageId=${stage.id}&sort=priority`)}
            >
              +{count - items.length} more →
            </button>
          )}
          {count === 0 && <div className="py-6 text-center text-xs text-slate-400">Drop items here</div>}
        </div>
      )}
    </div>
  );
});

const CardView = memo(function CardView({ item, compact }: { item: ItemCard; compact: boolean }) {
  const ctx = useCanvasCtx();
  const hl = useHighlight(item);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CARD_MIME, item.id);
        e.dataTransfer.effectAllowed = 'move';
        ctx.setDragging(item);
      }}
      onDragEnd={() => ctx.setDragging(null)}
      onClick={() => ctx.openItem(item.id)}
      className={`nodrag cursor-pointer rounded-lg border bg-white p-2 text-left shadow-sm transition hover:border-brand-500 ${hl ? 'animate-pulse border-emerald-500 ring-2 ring-emerald-200' : 'border-slate-200'}`}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <span>{TYPE_META[item.type].icon}</span>
        <span className="font-mono text-slate-500">{item.key}</span>
        <span className="ml-auto flex items-center gap-1">
          {item.isOverdue && <span title="Overdue">⏰</span>}
          <PriorityChip priority={item.priority} />
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-slate-900">{item.title}</div>
      {compact ? (
        <div className="mt-1 flex items-center gap-1">
          <Avatar user={item.assignee} size={18} />
          {item.isBlocked && <span className="text-xs">⛓</span>}
          {item.awaitingApproval && <span className="text-xs">✋</span>}
        </div>
      ) : (
        <>
          {item.descriptionExcerpt && <div className="mt-0.5 line-clamp-2 text-xs italic text-slate-500">“{item.descriptionExcerpt}”</div>}
          {item.nextAction && <div className="mt-1 text-xs text-slate-700">➡ {item.nextAction}</div>}
          {(item.isBlocked || item.awaitingApproval) && (
            <div className="mt-1 flex gap-2 text-xs">
              {item.isBlocked && <span className="text-red-700">⛓ Blocked</span>}
              {item.awaitingApproval && <span className="text-amber-700">✋ Needs approval</span>}
            </div>
          )}
          <WorkerNode item={item} />
          {item.lastChange && (
            <div className="mt-1 truncate text-[11px] text-slate-400">
              🕘 {item.lastChange.actor?.fullName.split(' ')[0] ?? 'System'} {item.lastChange.summary} · {timeAgo(item.lastChange.at)}
            </div>
          )}
          {item.noteCount > 0 && <div className="text-[11px] text-slate-400">💬 {item.noteCount}</div>}
        </>
      )}
    </div>
  );
});

/** The assignee's mini profile on a card; click → their company profile. */
function WorkerNode({ item }: { item: ItemCard }) {
  const ctx = useCanvasCtx();
  if (!item.assignee) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed border-slate-300 px-2 py-1.5 text-xs text-slate-500">
        <Avatar user={null} size={22} /> Unassigned
        {ctx.canEdit && (
          <button
            className="ml-auto rounded bg-brand-600 px-2 py-0.5 font-medium text-white hover:bg-brand-700"
            onClick={(e) => {
              e.stopPropagation();
              ctx.claim(item);
            }}
          >
            Claim
          </button>
        )}
      </div>
    );
  }
  const w = item.assignee;
  return (
    <Link
      to={`/people/${w.id}`}
      onClick={(e) => e.stopPropagation()}
      draggable={false}
      className="mt-2 flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200 hover:ring-brand-500"
    >
      <Avatar user={w} size={26} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-xs font-semibold text-slate-800">{w.fullName}</span>
        <span className="block truncate text-[11px] text-slate-500">
          {w.designation} · {w.projectRole ? ROLE_LABEL[w.projectRole] : ''}
        </span>
      </span>
      <span className="text-[11px] text-slate-500" title="Open items assigned">{w.openItemCount} open</span>
    </Link>
  );
}

/** Briefly highlight a card whose version just changed (someone else moved or edited it). */
function useHighlight(item: ItemCard) {
  const prev = useRef(item.version);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (item.version !== prev.current) {
      prev.current = item.version;
      setOn(true);
      const t = setTimeout(() => setOn(false), 2000);
      return () => clearTimeout(t);
    }
  }, [item.version]);
  return on;
}

// ------------------------------------------------------------------ drawing elements

export type DrawNodeType = Node<{ el: CanvasElement }, 'shape' | 'sticky' | 'text' | 'freehand'>;

const STROKES: Record<string, string> = { slate: '#334155', blue: '#2563eb', red: '#dc2626', green: '#16a34a', amber: '#d97706' };

export const ShapeNode = memo(function ShapeNode({ data, selected }: NodeProps<DrawNodeType>) {
  const el = data.el;
  const stroke = STROKES[el.props.stroke ?? 'slate'] ?? STROKES.slate;
  const fill = el.props.fill ?? 'transparent';
  return (
    <div className="group relative h-full w-full">
      <Resizer selected={selected} el={el} />
      <Handles />
      {/* A 100×100 viewBox stretched to the node; strokes stay 2px whatever the size. */}
      <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
        {el.type === 'rectangle' && <rect x="1" y="1" width="98" height="98" rx="4" fill={fill} stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        {el.type === 'ellipse' && <ellipse cx="50" cy="50" rx="49" ry="49" fill={fill} stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        {el.type === 'diamond' && <polygon points="50,1 99,50 50,99 1,50" fill={fill} stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center p-3 text-center text-sm text-slate-800">
        <EditableText el={el} className="flex items-center justify-center text-center" placeholder="" />
      </div>
    </div>
  );
});

const STICKY: Record<string, string> = {
  yellow: 'bg-yellow-100 border-yellow-300',
  pink: 'bg-pink-100 border-pink-300',
  green: 'bg-emerald-100 border-emerald-300',
  blue: 'bg-sky-100 border-sky-300',
};

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps<DrawNodeType>) {
  const el = data.el;
  return (
    <div className={`group h-full w-full rounded-sm border p-3 text-sm text-slate-800 shadow-md ${STICKY[el.props.color ?? 'yellow'] ?? STICKY.yellow}`}>
      <Resizer selected={selected} el={el} minWidth={100} minHeight={60} />
      <Handles />
      <EditableText el={el} placeholder="Double-click to write" />
      {el.updatedBy && <div className="absolute bottom-1 right-2 text-[10px] text-slate-500">— {el.updatedBy.initials}</div>}
    </div>
  );
});

export const TextNode = memo(function TextNode({ data, selected }: NodeProps<DrawNodeType>) {
  const el = data.el;
  return (
    <div className="group h-full w-full text-slate-800" style={{ fontSize: el.props.fontSize ?? 18 }}>
      <Resizer selected={selected} el={el} minWidth={60} minHeight={24} />
      <Handles />
      <EditableText el={el} placeholder="Text" />
    </div>
  );
});

export const FreehandNode = memo(function FreehandNode({ data, selected }: NodeProps<DrawNodeType>) {
  const el = data.el;
  const pts: [number, number][] = el.props.points ?? [];
  // Points are stored relative to the size the stroke was drawn at; the viewBox scales them.
  const w0 = el.props.w || el.width || 1;
  const h0 = el.props.h || el.height || 1;
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  return (
    <div className="group h-full w-full">
      <Resizer selected={selected} el={el} minWidth={10} minHeight={10} />
      <svg className="h-full w-full overflow-visible" viewBox={`0 0 ${w0} ${h0}`} preserveAspectRatio="none">
        <path
          d={d}
          fill="none"
          stroke={STROKES[el.props.stroke ?? 'slate']}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
});

export const nodeTypes = {
  project: ProjectNode,
  stage: StageNode,
  shape: ShapeNode,
  sticky: StickyNode,
  text: TextNode,
  freehand: FreehandNode,
};
