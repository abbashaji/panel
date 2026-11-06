import { describe, expect, it } from 'vitest';
import type { PanelCell, PanelDepend } from '../core/types';
import { BADGE_H, CARD_H, CARD_W, COL_PITCH, ROW_PITCH, badgeRules, cardStatus, layoutCells, metaLine, primaryAction, type Layout } from './layout';

const impl = (id: string): PanelDepend => ({ id, kind: 'implementation' });
const contract = (id: string): PanelDepend => ({ id, kind: 'contract' });

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

// A -> B (implementation), A -> C (contract), B and C -> D
const cells = [cell('A', 1), cell('B', 2, [impl('A')]), cell('C', 2, [contract('A')]), cell('D', 3, [impl('B'), impl('C')])];

const at = (l: Layout, id: string) => {
  const n = l.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

describe('layoutCells', () => {
  it('puts dependencies left of their dependents', () => {
    const l = layoutCells(cells);
    expect(l.edges).toHaveLength(4);
    for (const e of l.edges) {
      const s = at(l, e.source);
      expect(s.x + s.width).toBeLessThan(at(l, e.target).x);
    }
  });

  it('flags only the edges that leave the bottleneck', () => {
    const l = layoutCells(cells, 'A');
    expect(l.edges.filter((e) => e.bottleneck).map((e) => e.id).sort()).toEqual(['A->B', 'A->C']);
    expect(at(l, 'A').bottleneck).toBe(true);
    expect(at(l, 'B').bottleneck).toBe(false);
    expect(layoutCells(cells).edges.some((e) => e.bottleneck)).toBe(false);
  });

  it('keeps contract and implementation edge kinds', () => {
    const kinds = Object.fromEntries(layoutCells(cells).edges.map((e) => [e.id, e.kind]));
    expect(kinds['A->B']).toBe('implementation');
    expect(kinds['A->C']).toBe('contract');
  });

  it('keeps one edge per pair and prefers implementation', () => {
    const l = layoutCells([cell('A', 1), cell('X', 2, [contract('A'), impl('A')])]);
    expect(l.edges).toHaveLength(1);
    expect(l.edges[0]?.kind).toBe('implementation');
  });

  it('ignores unknown and self dependencies', () => {
    const l = layoutCells([cell('E', 2, [impl('ZZ'), impl('E')])]);
    expect(l.nodes).toHaveLength(1);
    expect(l.edges).toHaveLength(0);
  });

  it('labels each wave above its nodes', () => {
    const l = layoutCells(cells);
    expect(l.waves.map((w) => w.label)).toEqual(['WAVE 1', 'WAVE 2', 'WAVE 3']);
    expect(l.waves.map((w) => w.count)).toEqual([1, 2, 1]);
    const top = Math.min(...l.nodes.map((n) => n.y));
    for (const w of l.waves) expect(w.y).toBeLessThan(top);
    const w2 = l.waves[1];
    expect(w2?.x).toBe(Math.min(at(l, 'B').x, at(l, 'C').x));
  });

  it('uses a 186px column pitch and a 96px row pitch, centered on the parent', () => {
    const l = layoutCells(cells);
    expect(COL_PITCH).toBe(CARD_W + 34);
    expect(ROW_PITCH).toBe(CARD_H + 24);
    expect(at(l, 'B').x - at(l, 'A').x).toBe(COL_PITCH);
    expect(at(l, 'D').x - at(l, 'B').x).toBe(COL_PITCH);
    expect(at(l, 'C').y - at(l, 'B').y).toBeCloseTo(ROW_PITCH, 5);
    expect((at(l, 'B').y + at(l, 'C').y) / 2).toBeCloseTo(at(l, 'A').y, 5);
  });

  it('keeps the badge row outside the card box and nodes apart', () => {
    const l = layoutCells(cells);
    for (const n of l.nodes) {
      expect(n.height).toBe(BADGE_H + CARD_H);
      // the card starts exactly where the badge row ends
      expect(n.y + BADGE_H).toBe(n.y + n.height - CARD_H);
    }
    for (const a of l.nodes) {
      for (const b of l.nodes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe('card helpers', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');

  it('picks the double-click action', () => {
    expect(primaryAction('ready')).toBe('start');
    expect(primaryAction('running')).toBe('open');
    expect(primaryAction('expired')).toBe('open');
    expect(primaryAction('done')).toBe('select');
    expect(primaryAction('waiting')).toBe('select');
  });

  it('makes the owner chip clickable for any owner of a running or expired cell', () => {
    const open = { label: 'BR \u00b7 Open chat', clickable: true };
    expect(badgeRules(cell('R', 1, [], { status: 'running' }), 'Bob Ray', false, 0).owner).toEqual(open);
    expect(badgeRules(cell('E', 1, [], { status: 'expired' }), 'Bob Ray', false, 0).owner).toEqual(open);
    expect(badgeRules(cell('G', 1, [], { status: 'ready' }), 'Bob Ray', false, 0).owner).toEqual({ label: 'BR \u00b7 Bob Ray', clickable: false });
    expect(badgeRules(cell('D', 1, [], { status: 'done' }), 'Bob Ray', false, 0).owner).toBeNull();
  });

  it('builds the meta line', () => {
    const merged = cell('M', 1, [], { status: 'done', lastCommit: { subject: 's', next: null, at: '2026-11-04T10:00:00Z' } });
    expect(metaLine(merged, now)).toBe('merged 2h ago');
    const running = cell('R', 1, [], { status: 'running', lease: { minutesLeft: 12, expiredMinutesAgo: null, ci: false } });
    expect(metaLine(running, now)).toBe('12m left');
    const blocked = cell('W', 2, [impl('A')], { blockedBy: ['A', 'B'] });
    expect(metaLine(blocked, now)).toBe('← A, B');
    expect(metaLine(cell('Z', 1), now)).toBe('');
  });
});

describe('Ready to resume on the card', () => {
  const resumeReady = cell('R', 1, [], { status: 'ready', resumable: true } as Partial<PanelCell>);
  const resumeExpired = cell('X', 1, [], { status: 'expired', resumable: true, reservedBy: 'Ann' } as Partial<PanelCell>);
  const reset = cell('Z', 1, [], { status: 'ready', resumable: false } as Partial<PanelCell>);

  it('cardStatus shows Ready to resume with the resume icon', () => {
    expect(cardStatus(resumeReady)).toEqual({ label: 'Ready to resume', icon: 'resume' });
    expect(cardStatus(resumeExpired)).toEqual({ label: 'Ready to resume', icon: 'resume' });
  });

  it('a reset cell and plain cells keep the old label and icon', () => {
    expect(cardStatus(reset)).toEqual({ label: 'Ready', icon: 'ready' });
    expect(cardStatus(cell('E', 1, [], { status: 'expired' }))).toEqual({ label: 'Lease expired', icon: 'expired' });
  });

  it('a resumable cell starts on double-click, also when the lease expired', () => {
    expect(primaryAction(resumeReady)).toBe('start');
    expect(primaryAction(resumeExpired)).toBe('start');
    expect(primaryAction('ready')).toBe('start');
    expect(primaryAction('expired')).toBe('open');
    expect(primaryAction('running')).toBe('open');
    expect(primaryAction({ status: 'expired', resumable: false })).toBe('open');
  });

  it('meta line says resume now; a reset cell says start now', () => {
    expect(metaLine(resumeReady)).toBe('resume now');
    expect(metaLine(resumeExpired)).toBe('resume now');
    expect(metaLine(reset)).toBe('start now');
  });

  it('badges: START on a resumable expired cell, and its owner chip does not open a chat', () => {
    const b = badgeRules(resumeExpired, 'Ann', false, 0);
    expect(b.start).toBe(true);
    expect(b.owner?.clickable).toBe(false);
    const plain = badgeRules(cell('E', 1, [], { status: 'expired' }), 'Ann', false, 0);
    expect(plain.start).toBe(false);
    expect(plain.owner?.clickable).toBe(true);
  });
});
