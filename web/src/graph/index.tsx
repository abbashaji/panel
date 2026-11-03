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

function Graph() {
  const { state, selection, search, statusFilter, theme, launcher, actions, select, clearSelection, moveSelection } = usePanel();
  const rf = useReactFlow();
  const byKeyboard = useRef(false);
  const cells = useMemo(() => state?.cells ?? [], [state]);
  const bottleneck = state?.bottleneck ?? null;
  const layout = useMemo(() => layoutCells(cells, bottleneck?.id ?? null), [cells, bottleneck?.id]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const onAct = useCallback(
    (id: string, action: CardAction) => {
      byKeyboard.current = false;
      const cell = cells.find((c) => c.id === id);
      if (!cell) return;
      const act = action === 'primary' ? primaryAction(cell.status, launcher.owner(id) !== null) : action;
      if (act === 'multi') select(id, true);
      else if (act === 'start') launcher.start(id);
      else if (act === 'open') launcher.open(id);
      else if (act === 'release') actions.requestRelease(id);
      else select(id);
    },
    [cells, launcher, actions, select],
  );

  const nodes = useMemo<Node[]>(() => {
    const q = search.trim().toLowerCase();
    const matches = (c: PanelCell) =>
      (q === '' || c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)) &&
      (statusFilter.length === 0 || statusFilter.includes(c.status));
    const byId = new Map(cells.map((c) => [c.id, c]));
    const cards = layout.nodes.flatMap((n): Node[] => {
      const cell = byId.get(n.id);
      if (!cell) return [];
      const data: CardData = {
        cell,
        owner: launcher.owner(n.id),
        bottleneck: n.bottleneck,
        blocks: n.bottleneck ? (bottleneck?.blocks ?? 0) : 0,
        selected: selection.includes(n.id),
        dim: !matches(cell),
        onAct,
      };
      return [
        {
          id: n.id,
          type: 'cell',
          position: { x: n.x, y: n.y },
          width: n.width,
          height: n.height,
          draggable: false,
          selectable: false,
          focusable: false,
          data,
        },
      ];
    });
    const waves = layout.waves.map(
      (w): Node => ({
        id: `wave-${w.wave}`,
        type: 'wave',
        position: { x: w.x, y: w.y },
        draggable: false,
        selectable: false,
        focusable: false,
        connectable: false,
        data: { label: w.label },
      }),
    );
    return [...waves, ...cards];
  }, [layout, cells, bottleneck, selection, search, statusFilter, launcher, onAct]);

  const edges = useMemo(() => layout.edges.map(toEdge), [layout.edges]);

  // after an arrow-key move, keep the selected card in view (clicks never re-center)
  useEffect(() => {
    if (!byKeyboard.current) return;
    byKeyboard.current = false;
    const id = selection[selection.length - 1];
    const n = id ? layoutRef.current.nodes.find((x) => x.id === id) : undefined;
    if (n) void rf.setCenter(n.x + NODE_W / 2, n.y + NODE_H / 2, { zoom: rf.getZoom(), duration: reducedMotion() ? 0 : 200 });
  }, [selection, rf]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // the context menu is portaled but still bubbles through React: leave its keys alone
    if (e.target instanceof HTMLElement && e.target.closest('[role="menu"]')) return;
    const dir: 1 | -1 | 0 =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    byKeyboard.current = true;
    moveSelection(dir);
  };

  return (
    <div className='flex h-full flex-col' tabIndex={0} aria-label='Dependency graph' style={{ outline: 'none' }} onKeyDown={onKeyDown}>
      {bottleneck && <Banner id={bottleneck.id} blocks={bottleneck.blocks} onRelease={() => actions.requestRelease(bottleneck.id)} />}
      <div className='min-h-0 flex-1'>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.15, duration: 0 }}
          minZoom={0.2}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          deleteKeyCode={null}
          onPaneClick={clearSelection}
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => (n.type === 'cell' ? STATUS_META[(n.data as CardData).cell.status].color : 'transparent')}
          />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function GraphView() {
  return (
    <ReactFlowProvider>
      <Graph />
    </ReactFlowProvider>
  );
}
