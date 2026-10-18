import type { Transition } from '@nops/shared';
import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, getBezierPath, getSmoothStepPath } from '@xyflow/react';
import { memo } from 'react';

export type TransitionEdgeType = Edge<{ transition: Transition; protectedTarget: boolean; backward: boolean }, 'transition'>;

/**
 * A workflow connection = an allowed move. Bold amber when it enters a protected (approval) stage,
 * dashed when it goes backwards (reject / reopen). Badges: R = reason required, L = Lead/Manager only.
 */
export const TransitionEdge = memo(function TransitionEdge(props: EdgeProps<TransitionEdgeType>) {
  const { data, selected } = props;
  const backward = data?.backward;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    borderRadius: 16,
    offset: backward ? 40 : 20,
  });
  const t = data?.transition;
  const color = selected ? '#2563eb' : data?.protectedTarget ? '#d97706' : backward ? '#94a3b8' : '#475569';
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{ stroke: color, strokeWidth: data?.protectedTarget ? 3 : 2, strokeDasharray: backward ? '6 5' : undefined }}
        interactionWidth={18}
      />
      {(t?.label || t?.requiresReason || t?.leadOnly || data?.protectedTarget) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute flex items-center gap-1 rounded-full border bg-white px-2 py-0.5 text-[11px] font-medium shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, borderColor: color, color }}
          >
            {data?.protectedTarget && <span title="Approval">🔒</span>}
            {t?.label}
            {t?.requiresReason && <span className="rounded bg-slate-100 px-1 text-slate-600" title="Reason required">R</span>}
            {t?.leadOnly && <span className="rounded bg-slate-100 px-1 text-slate-600" title="Lead or Manager only">L</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export type ArrowEdgeType = Edge<Record<string, never>, 'arrow'>;

/** A free drawing arrow between two elements (no workflow meaning). */
export const ArrowEdge = memo(function ArrowEdge(props: EdgeProps<ArrowEdgeType>) {
  const [path] = getBezierPath(props);
  return (
    <BaseEdge
      id={props.id}
      path={path}
      markerEnd={props.markerEnd}
      style={{ stroke: props.selected ? '#2563eb' : '#64748b', strokeWidth: 2 }}
      interactionWidth={16}
    />
  );
});

export const edgeTypes = { transition: TransitionEdge, arrow: ArrowEdge };
