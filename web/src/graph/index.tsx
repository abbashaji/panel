import '@xyflow/react/dist/style.css';
import {
  Background,
  BaseEdge,
  ControlButton,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { STATUS_META } from '../core/status';
import { usePanel } from '../core/store';
import { visibleCells } from '../shell/filter';
import { Banner, showBanner } from './Banner';
import { CellCard, type CardAction, type CardData } from './CellCard';
import { NODE_H, NODE_W, cellsLabel, layoutCells, primaryAction, type LayoutEdge } from './layout';

type WaveNode = Node<{ label: string; count: number }, 'wave'>;

function WaveLabel({ data }: NodeProps<WaveNode>) {
  return (
    <div className='whitespace-nowrap' style={{ fontSize: 11 }}>
      <span style={{ color: 'var(--muted-2)', fontWeight: 600, letterSpacing: '.08em' }}>{data.label}</span>
      <span style={{ color: '#6F7890', fontWeight: 500 }}> · {cellsLabel(data.count)}</span>
    </div>
  );
}

const nodeTypes = { cell: CellCard, wave: WaveLabel };

const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const BOTTLENECK_COLOR = STATUS_META.expired.color;

/** the context menu is portaled but its events still bubble through React to the node: ignore them */
const fromMenu = (e: ReactMouseEvent): boolean => e.target instanceof HTMLElement && e.target.closest('[role="menu"]') !== null;

/** bezier from the right middle of the source to the left middle of the target; solid = implementation, dashed = contract, red = leaves the bottleneck */
function BpEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const bottleneck = data?.bottleneck === true;
  const off = Math.max(40, Math.abs(targetX - sourceX) * 0.35);
  const path = `M ${sourceX} ${sourceY} C ${sourceX + off} ${sourceY}, ${targetX - off} ${targetY}, ${targetX} ${targetY}`;
  return (
    <BaseEdge
      id={id}
      path={path}
      style={{
        stroke: bottleneck ? BOTTLENECK_COLOR : 'var(--edge)',
        strokeWidth: bottleneck ? 2 : 1.5,
        opacity: bottleneck ? 0.85 : 1,
        strokeDasharray: data?.kind === 'contract' ? '5 4' : undefined,
      }}
    />
  );
}

const edgeTypes = { bp: BpEdge };

/** solid = implementation, dashed = contract, red = leaves the bottleneck */
function toEdge(e: LayoutEdge): Edge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'bp',
    selectable: false,
    focusable: false,
    zIndex: e.bottleneck ? 1 : 0,
    data: { kind: e.kind, bottleneck: e.bottleneck },
  };
}

function Graph() {
  const { state, selection, search, statusFilter, criticalOnly, hideMerged, theme, launcher, actions, select, clearSelection, moveSelection } =
    usePanel();
  const rf = useReactFlow();
  const byKeyboard = useRef(false);
  const fit = useCallback(() => {
    void rf.fitView({ padding: 0.15, duration: reducedMotion() ? 0 : 200 });
  }, [rf]);  const allCells = useMemo(() => state?.cells ?? [], [state]);
  // search, status filter, critical path only and hide merged remove cells (and their edges) from the graph
  const cells = useMemo(
    () => visibleCells(allCells, { search, statuses: statusFilter, criticalOnly, hideMerged }),
    [allCells, search, statusFilter, criticalOnly, hideMerged],
  );
  const bottleneck = state?.bottleneck ?? null;
  const bottleneckCell = bottleneck ? allCells.find((c) => c.id === bottleneck.id) : undefined;
  const layout = useMemo(() => layoutCells(cells, bottleneck?.id ?? null), [cells, bottleneck?.id]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const onAct = useCallback(
    (id: string, action: CardAction) => {
      byKeyboard.current = false;
      const cell = cells.find((c) => c.id === id);
      if (!cell) return;
      const act = action === 'primary' ? primaryAction(cell.status) : action;
      if (act === 'multi') select(id, true);
      else if (act === 'start') launcher.start(id);
      else if (act === 'open') launcher.open(id);
      else if (act === 'release') actions.requestRelease(id);
      else select(id);
    },
    [cells, launcher, actions, select],
  );

  /** one click path: React Flow reports the click on the node; the card body has no click handler of its own */
  const onNodeClick = useCallback(
    (e: ReactMouseEvent, node: Node) => {
      if (node.type !== 'cell' || fromMenu(e)) return;
      byKeyboard.current = false;
      select(node.id, e.shiftKey);
    },
    [select],
  );
  const onNodeDoubleClick = useCallback(
    (e: ReactMouseEvent, node: Node) => {
      if (node.type !== 'cell' || fromMenu(e)) return;
      onAct(node.id, 'primary');
    },
    [onAct],
  );

  const nodes = useMemo<Node[]>(() => {
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
        data: { label: w.label, count: w.count },
      }),
    );
    return [...waves, ...cards];
  }, [layout, cells, bottleneck, selection, launcher, onAct]);

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
      {bottleneck && showBanner(bottleneckCell) && (
        <Banner cell={bottleneckCell} blocks={bottleneck.blocks} onRelease={() => actions.requestRelease(bottleneck.id)} />
      )}
      <div className='min-h-0 flex-1'>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
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
          zoomOnDoubleClick={false}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onPaneClick={clearSelection}
        >
          <Background />
          <Controls showInteractive={false} showFitView={false} position='bottom-left'>
            <ControlButton onClick={fit} title='Fit graph to view' aria-label='Fit graph to view'>
              <span style={{ fontSize: 10, fontWeight: 700 }}>Fit</span>
            </ControlButton>
          </Controls>
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
