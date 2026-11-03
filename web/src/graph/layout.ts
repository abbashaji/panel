import * as dagre from '@dagrejs/dagre';
import type { DependKind, PanelCell } from '../core/types';

export const CARD_W = 152;
export const CARD_H = 72;
/** Row above every card for the START / owner / BLOCKS badges. The card box starts below it, so badges never touch the card. */
export const BADGE_H = 22;
export const NODE_W = CARD_W;
export const NODE_H = BADGE_H + CARD_H;
const WAVE_LABEL_GAP = 40;

export interface LayoutNode {
  id: string;
  /** top-left of the node box (badge row + card) */
  x: number;
  y: number;
  width: number;
  height: number;
  wave: number;
  bottleneck: boolean;
}

export interface LayoutEdge {
  id: string;
  /** the dependency (left) */
  source: string;
  /** the dependent (right) */
  target: string;
  kind: DependKind;
  /** the edge leaves the bottleneck cell */
  bottleneck: boolean;
}

export interface WaveLabel {
  wave: number;
  label: string;
  x: number;
  y: number;
  width: number;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  waves: WaveLabel[];
}

export type PrimaryAction = 'start' | 'open' | 'select';

/** Left-to-right dependency layout. bottleneckId comes from PanelState.bottleneck (cells alone do not say which cell it is). */
export function layoutCells(cells: PanelCell[], bottleneckId: string | null = null): Layout {
  const ids = new Set(cells.map((c) => c.id));
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 90, nodesep: 24, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const c of cells) g.setNode(c.id, { width: NODE_W, height: NODE_H });

  const edgeMap = new Map<string, LayoutEdge>();
  for (const c of cells) {
    for (const d of c.depends) {
      if (d.id === c.id || !ids.has(d.id)) continue;
      const id = `${d.id}->${c.id}`;
      const prev = edgeMap.get(id);
      // one edge per pair; implementation wins over contract
      if (prev && (prev.kind === 'implementation' || d.kind === 'contract')) continue;
      g.setEdge(d.id, c.id);
      edgeMap.set(id, { id, source: d.id, target: c.id, kind: d.kind, bottleneck: d.id === bottleneckId });
    }
  }
  dagre.layout(g);

  const nodes: LayoutNode[] = cells.map((c) => {
    const p = g.node(c.id);
    return {
      id: c.id,
      x: p.x - NODE_W / 2,
      y: p.y - NODE_H / 2,
      width: NODE_W,
      height: NODE_H,
      wave: c.wave,
      bottleneck: c.id === bottleneckId,
    };
  });

  const top = nodes.length > 0 ? Math.min(...nodes.map((n) => n.y)) : 0;
  const byWave = new Map<number, LayoutNode[]>();
  for (const n of nodes) byWave.set(n.wave, [...(byWave.get(n.wave) ?? []), n]);
  const waves: WaveLabel[] = [...byWave.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wave, ns]) => {
      const x = Math.min(...ns.map((n) => n.x));
      const right = Math.max(...ns.map((n) => n.x + n.width));
      return { wave, label: `Wave ${wave}`, x, y: top - WAVE_LABEL_GAP, width: right - x };
    });

  return { nodes, edges: [...edgeMap.values()], waves };
}

/** What a double-click does: Start if ready, Open chat if running and owned, else just select. */
export function primaryAction(status: PanelCell['status'], hasOwner: boolean): PrimaryAction {
  if (status === 'ready') return 'start';
  if (status === 'running' && hasOwner) return 'open';
  return 'select';
}

export function ago(iso: string, now: number = Date.now()): string {
  const min = Math.round((now - Date.parse(iso)) / 60000);
  if (Number.isNaN(min)) return '';
  const m = Math.max(0, min);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}

/** The single meta line on a card: merged ago / lease left / blocked by. Empty when none applies. */
export function metaLine(cell: PanelCell, now: number = Date.now()): string {
  if (cell.status === 'done') {
    const t = cell.lastCommit ? ago(cell.lastCommit.at, now) : '';
    return t ? `merged ${t}` : 'merged';
  }
  if (cell.lease && cell.lease.expiredMinutesAgo != null) return `lease expired ${cell.lease.expiredMinutesAgo}m ago`;
  if (cell.lease) return `${cell.lease.minutesLeft}m lease left`;
  if (cell.blockedBy.length > 0) return `blocked by ${cell.blockedBy.join(', ')}`;
  return '';
}
