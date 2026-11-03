import '@xyflow/react/dist/style.css';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { STATUS_META } from '../core/status';
import { usePanel } from '../core/store';
import type { PanelCell } from '../core/types';
import { CellCard, type CardAction, type CardData } from './CellCard';
import { NODE_H, NODE_W, layoutCells, primaryAction, type LayoutEdge } from './layout';

type WaveNode = Node<{ label: string }, 'wave'>;

function WaveLabel({ data }: NodeProps<WaveNode>) {
  return (
    <div className='mono whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider' style={{ color: 'var(--muted)' }}>
      {data.label}
    </div>
  );
}

const nodeTypes = { cell: CellCard, wave: WaveLabel };

const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// SVG markers need a concrete color (CSS variables do not resolve in marker attributes)
const EDGE_COLOR = STATUS_META.waiting.color;
const BOTTLENECK_COLOR = STATUS_META.expired.color;

/** solid = implementation, dashed = contract, red = leaves the bottleneck */
function toEdge(e: LayoutEdge): Edge {
  const color = e.bottleneck ? BOTTLENECK_COLOR : EDGE_COLOR;
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'smoothstep',
    selectable: false,
    focusable: false,
    zIndex: e.bottleneck ? 1 : 0,
    style: {
      stroke: color,
      strokeWidth: e.bottleneck ? 2.5 : 1.5,
      strokeDasharray: e.kind === 'contract' ? '6 4' : undefined,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color },
  };
}

function Banner({ id, blocks, onRelease }: { id: string; blocks: number; onRelease: () => void }) {
  return (
    <div
      role='status'
      className='flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs'
      style={{ background: 'var(--surface)', borderColor: BOTTLENECK_COLOR }}
    >
      <span aria-hidden style={{ color: BOTTLENECK_COLOR }}>
        !
      </span>
      <span>
        <strong className='mono'>{id}</strong> is the bottleneck and blocks {blocks} {blocks === 1 ? 'cell' : 'cells'}.
      </span>
      <span className='flex-1' />
      <button
        type='button'
        onClick={onRelease}
        className='rounded border px-2 py-1 font-semibold'
        style={{ borderColor: BOTTLENECK_COLOR, color: BOTTLENECK_COLOR }}
      >
        Release
      </button>
    </div>
  );
}
