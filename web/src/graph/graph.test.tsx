import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PanelCell, PanelDepend } from '../core/types';
import { visibleCells, type CellFilters } from '../shell/filter';
import { Banner, bannerParts, bannerText, showBanner } from './Banner';
import { badgeRules, cellsLabel, initials, layoutCells, metaLine, shaLabel } from './layout';

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
    expect(badgeRules(cell('A', 1, [], { status: 'ready' }), null, false, false, 0).start).toBe(true);
    expect(badgeRules(cell('A', 1, [], { status: 'running' }), null, false, false, 0).start).toBe(false);
    expect(badgeRules(cell('A', 1), null, false, false, 0).owner).toBeNull();
  });

  it('offers Open chat only on your own running cell', () => {
    const running = cell('A', 1, [], { status: 'running' });
    expect(badgeRules(running, 'Ali Lee', true, false, 0).owner).toEqual({ label: 'AL \u00b7 Open chat', clickable: true });
    expect(badgeRules(running, 'Ana Hill', false, false, 0).owner).toEqual({ label: 'AH \u00b7 Ana Hill', clickable: false });
    const mineButReady = cell('B', 1, [], { status: 'ready' });
    expect(badgeRules(mineButReady, 'Ali Lee', true, false, 0).owner?.clickable).toBe(false);
  });

  it('never shows an owner chip on merged cells', () => {
    expect(badgeRules(cell('A', 1, [], { status: 'done' }), 'Ali Lee', true, false, 0).owner).toBeNull();
  });

  it('shows BLOCKS n on the bottleneck only', () => {
    const c = cell('A', 1, [], { status: 'expired' });
    expect(badgeRules(c, null, false, true, 8).blocks).toBe(8);
    expect(badgeRules(c, null, false, false, 8).blocks).toBeNull();
    expect(badgeRules(c, null, false, true, 0).blocks).toBeNull();
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
