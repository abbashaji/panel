import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelCell, PanelDepend } from '../core/types';
import { visibleCells, type CellFilters } from '../shell/filter';
import { Banner, bannerParts, bannerText, showBanner } from './Banner';
import GraphView from './index';
import { badgeRules, cellsLabel, initials, layoutCells, metaLine, shaLabel } from './layout';

// jsdom lacks what React Flow measures with.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver ??= RO;
(globalThis as any).DOMMatrixReadOnly ??= class {
  m22 = 1;
  constructor(_t?: string) {}
};

const h = vi.hoisted(() => {
  const select = vi.fn();
  const clearSelection = vi.fn();
  const start = vi.fn();
  const open = vi.fn();
  const panel = {
    state: { cells: [] as unknown[], bottleneck: null },
    repo: 'demo/panel',
    selection: [] as string[],
    search: '',
    statusFilter: [] as string[],
    criticalOnly: false,
    hideMerged: false,
    theme: 'dark',
    launcher: { owner: (_id: string): string | null => null, start, open },
    actions: { requestRelease: vi.fn() },
    select,
    clearSelection,
    moveSelection: vi.fn(),
  };
  return { panel, select, clearSelection, start, open };
});

vi.mock('../core/store', async (orig) => {
  const real = await orig<typeof import('../core/store')>();
  return { ...real, usePanel: () => h.panel };
});

const impl = (id: string): PanelDepend => ({ id, kind: 'implementation' });

function cell(id: string, wave: number, depends: PanelDepend[] = [], over: Partial<PanelCell> = {}): PanelCell {
  return {
    id,
    title: `Cell ${id}`,
    type: 'normal',
    priority: 0,
    status: 'waiting',
    critical: false,
    wave,
    depends,
    blockedBy: [],
    directDependents: 0,
    transitiveDependents: 0,
    sha: { lock: null, tip: null, merged: null },
    lease: null,
    attempts: 0,
    maxAttempts: 3,
    lastCommit: null,
    reservedBy: null,
    pr: null,
    allowedPaths: [],
    provides: [],
    inputs: [],
    ...over,
  };
}

const now = Date.parse('2026-11-04T12:00:00Z');

describe('meta lines', () => {
  it('follows the status', () => {
    const merged = cell('M', 1, [], { status: 'done', lastCommit: { subject: 's', next: null, at: '2026-11-04T09:00:00Z' } });
    expect(metaLine(merged, now)).toBe('merged 3h ago');
    expect(metaLine(cell('M2', 1, [], { status: 'done' }), now)).toBe('merged');
    const running = cell('R', 1, [], { status: 'running', lease: { minutesLeft: 34, expiredMinutesAgo: null, ci: false } });
    expect(metaLine(running, now)).toBe('34m left');
    const expired = cell('E', 1, [], { status: 'expired', lease: { minutesLeft: 0, expiredMinutesAgo: 22, ci: false } });
    expect(metaLine(expired, now)).toBe('expired 22m ago');
    expect(metaLine(cell('W', 2, [impl('A')], { blockedBy: ['C-004', 'C-006'] }), now)).toBe('\u2190 C-004, C-006');
    expect(metaLine(cell('H', 1, [], { status: 'needs_human' }), now)).toBe('feedback sent');
    expect(metaLine(cell('G', 1, [], { status: 'ready' }), now)).toBe('start now');
    expect(metaLine(cell('S', 1, [], { status: 'needs_split' }), now)).toBe('');
  });

  it('shows sha7 or a dash', () => {
    expect(shaLabel(cell('A', 1, [], { sha: { lock: 'aaaaaaaaaa', tip: 'bbbbbbbbbb', merged: null } }))).toBe('bbbbbbb');
    expect(shaLabel(cell('A', 1, [], { sha: { lock: 'aaaaaaaaaa', tip: 'bbbbbbbbbb', merged: 'cccccccccc' } }))).toBe('ccccccc');
    expect(shaLabel(cell('A', 1))).toBe('\u2014');
  });
});

describe('badge rules', () => {
  it('builds initials', () => {
    expect(initials('Ali Lee')).toBe('AL');
    expect(initials('acct-a')).toBe('AA');
    expect(initials('zoe')).toBe('ZO');
    expect(initials('  ')).toBe('?');
  });

  it('shows START on ready cells only', () => {
    expect(badgeRules(cell('A', 1, [], { status: 'ready' }), null, false, 0).start).toBe(true);
    expect(badgeRules(cell('A', 1, [], { status: 'running' }), null, false, 0).start).toBe(false);
    expect(badgeRules(cell('A', 1), null, false, 0).owner).toBeNull();
  });

  it('offers Open chat to anyone on a running or expired cell', () => {
    const running = cell('A', 1, [], { status: 'running' });
    expect(badgeRules(running, 'Ali Lee', false, 0).owner).toEqual({ label: 'AL \u00b7 Open chat', clickable: true });
    expect(badgeRules(running, 'Ana Hill', false, 0).owner).toEqual({ label: 'AH \u00b7 Open chat', clickable: true });
    const expired = cell('E', 1, [], { status: 'expired' });
    expect(badgeRules(expired, 'Ana Hill', false, 0).owner?.clickable).toBe(true);
    const ready = cell('B', 1, [], { status: 'ready' });
    expect(badgeRules(ready, 'Ali Lee', false, 0).owner).toEqual({ label: 'AL \u00b7 Ali Lee', clickable: false });
  });

  it('never shows an owner chip on merged cells', () => {
    expect(badgeRules(cell('A', 1, [], { status: 'done' }), 'Ali Lee', false, 0).owner).toBeNull();
  });

  it('shows BLOCKS n on the bottleneck only', () => {
    const c = cell('A', 1, [], { status: 'expired' });
    expect(badgeRules(c, null, true, 8).blocks).toBe(8);
    expect(badgeRules(c, null, false, 8).blocks).toBeNull();
    expect(badgeRules(c, null, true, 0).blocks).toBeNull();
  });
});

describe('banner', () => {
  const stuck = cell('C-004', 1, [], {
    title: 'API core',
    status: 'expired',
    lease: { minutesLeft: 0, expiredMinutesAgo: 22, ci: false },
    attempts: 2,
    maxAttempts: 3,
  });

  it('words the message', () => {
    expect(bannerText(stuck, 8)).toBe('C-004 API core is holding up 8 cells. Its lease expired 22 min ago (attempt 2 of 3).');
    expect(bannerParts(stuck, 1).head).toBe('C-004 API core');
    expect(bannerText(stuck, 1)).toContain('holding up 1 cell.');
    expect(cellsLabel(0)).toBe('0 cells');
  });

  it('shows only when the bottleneck is expired', () => {
    expect(showBanner(stuck)).toBe(true);
    expect(showBanner(cell('R', 1, [], { status: 'running' }))).toBe(false);
    expect(showBanner(undefined)).toBe(false);
    expect(showBanner(null)).toBe(false);
  });

  it('renders the text and the Release now button', () => {
    const html = renderToStaticMarkup(<Banner cell={stuck} blocks={8} onRelease={vi.fn()} />);
    expect(html.replace(/<[^>]*>/g, '')).toContain('C-004 API core is holding up 8 cells. Its lease expired 22 min ago (attempt 2 of 3).');
    expect(html).toContain('Release now');
  });
});

describe('visible cells in the layout', () => {
  const all = [
    cell('A', 1, [], { status: 'done', critical: true }),
    cell('B', 2, [impl('A')], { critical: true }),
    cell('C', 2, [impl('A')]),
  ];
  const base: CellFilters = { search: '', statuses: [], criticalOnly: false, hideMerged: false };
  const ids = (f: CellFilters) => visibleCells(all, f).map((c) => c.id);

  it('drops hidden cells and their edges', () => {
    expect(layoutCells(visibleCells(all, base)).edges).toHaveLength(2);
    const noMerged = visibleCells(all, { ...base, hideMerged: true });
    expect(noMerged.map((c) => c.id)).toEqual(['B', 'C']);
    const l = layoutCells(noMerged);
    expect(l.nodes.map((n) => n.id).sort()).toEqual(['B', 'C']);
    expect(l.edges).toHaveLength(0);
  });

  it('applies critical only, search and the status filter', () => {
    expect(ids({ ...base, criticalOnly: true })).toEqual(['A', 'B']);
    expect(ids({ ...base, search: 'cell c' })).toEqual(['C']);
    expect(ids({ ...base, statuses: ['done'] })).toEqual(['A']);
    const l = layoutCells(visibleCells(all, { ...base, criticalOnly: true }));
    expect(l.edges.map((e) => e.id)).toEqual(['A->B']);
    expect(l.waves.map((w) => w.count)).toEqual([1, 1]);
  });
});

describe('graph interaction', () => {
  beforeEach(() => {
    h.select.mockClear();
    h.clearSelection.mockClear();
    h.start.mockClear();
    h.open.mockClear();
    h.panel.launcher.owner = (_id: string): string | null => null;
    h.panel.state.cells = [cell('A', 1, [], { status: 'ready' }), cell('B', 2, [impl('A')], { blockedBy: ['A'] })];
  });
  afterEach(() => cleanup());

  const card = (id: string) => screen.getByLabelText(new RegExp(`^${id}, `));

  it('selects a card exactly once on click', () => {
    render(<GraphView />);
    fireEvent.click(card('A'));
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.select).toHaveBeenCalledWith('A', false);
  });

  it('shift-click adds to the selection', () => {
    render(<GraphView />);
    fireEvent.click(card('B'), { shiftKey: true });
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.select).toHaveBeenCalledWith('B', true);
  });

  it('double-click on a ready cell starts it', () => {
    render(<GraphView />);
    fireEvent.doubleClick(card('A'));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith('A');
  });

  it('double-click on a waiting cell only selects it', () => {
    render(<GraphView />);
    fireEvent.doubleClick(card('B'));
    expect(h.start).not.toHaveBeenCalled();
    expect(h.select).toHaveBeenCalledWith('B');
  });

  describe('a teammate who did not start the cell', () => {
    beforeEach(() => {
      h.panel.launcher.owner = (id: string): string | null => (id === 'R' || id === 'X' ? 'Bob Ray' : null);
      h.panel.state.cells = [
        cell('R', 1, [], { status: 'running', reservedBy: 'Bob Ray' }),
        cell('X', 1, [], { status: 'expired', reservedBy: 'Bob Ray' }),
      ];
    });

    it('gets a clickable owner chip that calls launcher.open', () => {
      render(<GraphView />);
      const chips = screen.getAllByRole('button', { name: 'BR \u00b7 Open chat' });
      expect(chips).toHaveLength(2);
      fireEvent.click(chips[0] as Element);
      expect(h.open).toHaveBeenCalledTimes(1);
      expect(h.open).toHaveBeenCalledWith('R');
      expect(document.body.textContent).not.toContain('Only the person');
    });

    it('gets the Open chat context menu item', async () => {
      render(<GraphView />);
      fireEvent.contextMenu(card('X'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Open chat' }));
      expect(h.open).toHaveBeenCalledWith('X');
      expect(document.body.textContent).not.toContain('Only the person');
    });

    it('opens the chat on double-click', () => {
      render(<GraphView />);
      fireEvent.doubleClick(card('R'));
      expect(h.open).toHaveBeenCalledWith('R');
      fireEvent.doubleClick(card('X'));
      expect(h.open).toHaveBeenCalledWith('X');
    });
  });

  it('clicking the pane clears the selection', () => {
    const { container } = render(<GraphView />);
    const pane = container.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    fireEvent.click(pane as Element);
    expect(h.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('has no minimap', () => {
    const { container } = render(<GraphView />);
    expect(container.querySelector('.react-flow__minimap')).toBeNull();
  });
});
