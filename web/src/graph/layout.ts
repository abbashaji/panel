import type { DependKind, PanelCell } from '../core/types';

export const CARD_W = 152;
export const CARD_H = 72;
/** Row above every card for the START / owner / BLOCKS badges. The card box starts below it, so badges never touch the card. */
export const BADGE_H = 22;
export const NODE_W = CARD_W;
export const NODE_H = BADGE_H + CARD_H;
/** 1:1 scale: 152 card + 34 gap between columns, 72 card + 24 gap between rows. */
export const COL_PITCH = CARD_W + 34;
export const ROW_PITCH = CARD_H + 24;
const MARGIN_X = 16;
const MARGIN_TOP = 44;
const WAVE_LABEL_GAP = 28;

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
  /** cells in this wave (visible ones only) */
  count: number;
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

/** Top-left (badge row included) of every node: one column per wave, 186px / 96px pitch, each column centered on its parents. */
function placeCells(cells: PanelCell[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (cells.length === 0) return out;
  const byId = new Map(cells.map((c) => [c.id, c] as const));
  const rank = new Map(
    [...new Set(cells.map((c) => c.wave))]
      .sort((a, b) => a - b)
      .map((w, i) => [w, i] as const),
  );
  const colMemo = new Map<string, number>();
  const visiting = new Set<string>();
  // a cell never sits left of (or in) the column of a cell it depends on
  const colOf = (c: PanelCell): number => {
    const memo = colMemo.get(c.id);
    if (memo !== undefined) return memo;
    let col = rank.get(c.wave) ?? 0;
    if (!visiting.has(c.id)) {
      visiting.add(c.id);
      for (const d of c.depends) {
        const p = byId.get(d.id);
        if (p && p.id !== c.id) col = Math.max(col, colOf(p) + 1);
      }
      visiting.delete(c.id);
      colMemo.set(c.id, col);
    }
    return col;
  };
  const columns = new Map<number, PanelCell[]>();
  for (const c of cells) {
    const k = colOf(c);
    columns.set(k, [...(columns.get(k) ?? []), c]);
  }
  const ys = new Map<string, number>();
  const cols = new Map<string, number>();
  for (const k of [...columns.keys()].sort((a, b) => a - b)) {
    const members = columns.get(k) ?? [];
    const want = members.map((c, i) => {
      const py = c.depends.map((d) => ys.get(d.id)).filter((y): y is number => y !== undefined);
      return py.length > 0 ? py.reduce((a, b) => a + b, 0) / py.length : i * ROW_PITCH;
    });
    const order = members.map((_, i) => i).sort((a, b) => (want[a] ?? 0) - (want[b] ?? 0) || a - b);
    const got: number[] = members.map(() => 0);
    let prev = -Infinity;
    for (const i of order) {
      prev = Math.max(want[i] ?? 0, prev + ROW_PITCH);
      got[i] = prev;
    }
    // push apart, then move the whole column back so it stays centered on what it wanted
    const shift = members.reduce((s, _, i) => s + ((want[i] ?? 0) - (got[i] ?? 0)), 0) / members.length;
    members.forEach((c, i) => {
      ys.set(c.id, (got[i] ?? 0) + shift);
      cols.set(c.id, k);
    });
  }
  const minY = Math.min(...ys.values());
  for (const c of cells) {
    out.set(c.id, { x: MARGIN_X + (cols.get(c.id) ?? 0) * COL_PITCH, y: (ys.get(c.id) ?? 0) - minY + MARGIN_TOP });
  }
  return out;
}

/** Left-to-right dependency layout. bottleneckId comes from PanelState.bottleneck (cells alone do not say which cell it is). Pass only the visible cells. */
export function layoutCells(cells: PanelCell[], bottleneckId: string | null = null): Layout {
  const ids = new Set(cells.map((c) => c.id));

  const edgeMap = new Map<string, LayoutEdge>();
  for (const c of cells) {
    for (const d of c.depends) {
      if (d.id === c.id || !ids.has(d.id)) continue;
      const id = `${d.id}->${c.id}`;
      const prev = edgeMap.get(id);
      // one edge per pair; implementation wins over contract
      if (prev && (prev.kind === 'implementation' || d.kind === 'contract')) continue;
      edgeMap.set(id, { id, source: d.id, target: c.id, kind: d.kind, bottleneck: d.id === bottleneckId });
    }
  }
  const pos = placeCells(cells);

  const nodes: LayoutNode[] = cells.map((c) => {
    const p = pos.get(c.id) ?? { x: MARGIN_X, y: MARGIN_TOP };
    return {
      id: c.id,
      x: p.x,
      y: p.y,
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
      return { wave, label: `WAVE ${wave}`, count: ns.length, x, y: top - WAVE_LABEL_GAP, width: right - x };
    });

  return { nodes, edges: [...edgeMap.values()], waves };
}

/** What a double-click does: Start if ready, Open chat if running or expired (for anyone), else just select. */
export function primaryAction(status: PanelCell['status']): PrimaryAction {
  if (status === 'ready') return 'start';
  if (status === 'running' || status === 'expired') return 'open';
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
  switch (cell.status) {
    case 'expired': {
      const m = cell.lease?.expiredMinutesAgo;
      return m != null ? `expired ${m}m ago` : 'expired';
    }
    case 'running':
      return cell.lease && cell.lease.expiredMinutesAgo == null ? `${cell.lease.minutesLeft}m left` : '';
    case 'waiting':
      return cell.blockedBy.length > 0 ? `← ${cell.blockedBy.join(', ')}` : '';
    case 'needs_human':
      return 'feedback sent';
    case 'ready':
      return 'start now';
    default:
      return '';
  }
}

/** Up to two uppercase letters: first letters of the first two name parts, else the first two letters. */
export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  const first = parts[0];
  if (!first) return '?';
  const second = parts[1];
  return (second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2)).toUpperCase();
}

export interface OwnerChip {
  label: string;
  /** any owner of a running or expired cell: opens the chat */
  clickable: boolean;
}

export interface BadgeRules {
  start: boolean;
  owner: OwnerChip | null;
  blocks: number | null;
}

/** Which badges sit above a card: START (ready), owner chip (never on merged cells), BLOCKS n (bottleneck only). */
export function badgeRules(cell: PanelCell, owner: string | null, bottleneck: boolean, blocks: number): BadgeRules {
  let chip: OwnerChip | null = null;
  if (owner && cell.status !== 'done') {
    const ini = initials(owner);
    const openable = cell.status === 'running' || cell.status === 'expired';
    chip = openable ? { label: `${ini} · Open chat`, clickable: true } : { label: `${ini} · ${owner}`, clickable: false };
  }
  return { start: cell.status === 'ready', owner: chip, blocks: bottleneck && blocks > 0 ? blocks : null };
}

/** sha7 shown on the card: merged, else tip, else lock; an em dash when none. */
export function shaLabel(cell: PanelCell): string {
  return (cell.sha.merged ?? cell.sha.tip ?? cell.sha.lock ?? '').slice(0, 7) || '—';
}

export const cellsLabel = (n: number): string => `${n} ${n === 1 ? 'cell' : 'cells'}`;
