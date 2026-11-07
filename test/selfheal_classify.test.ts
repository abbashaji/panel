import { describe, expect, it } from 'vitest';
import { BRIEFING_MAX_CHARS, briefing, classifyProblem, staleDepsOf, type Ctx, type Evidence, type Facts } from '../src/selfheal.ts';

const q = JSON.stringify;
const head = (tool: string, kind: string): string => `${tool}(repo=${q('o/r')}, cell_id=${q('C-070')}, base=${q('c231e07')}, kind=${q(kind)}`;
const GATE = 'submit_cell rejected: dependencies not merged yet: C-050';

const cells: Record<string, any> = {
  'C-050': { id: 'C-050', title: 'old', goal: 'g' },
  'C-051': { id: 'C-051', title: 'new', goal: 'g', supersedes: ['C-050'] },
  'C-059': { id: 'C-059', title: 'other', goal: 'g' },
  'C-070': { id: 'C-070', title: 'heal', goal: 'goal text', after: ['C-050', 'C-059'], allowed_paths: ['src/a.ts'], outputs: ['src/a.ts'], acceptance: [{ cmd: 'npm test' }] },
};
const F = (o: Partial<Facts> = {}): Facts => ({ behind: 0, outside: [], ownMention: false, mainRed: false, missingContract: false, ...o });
const ctx = (): Ctx => ({ id: 'C-070', snap: {} as any, plan: { cells } as any, branch: { oid: 'c231e07aaaa', message: 'cell(C-070): claim' } as any });
const EV = (o: Partial<Evidence> = {}): Evidence => ({ behind: 0, ahead: 0, mainRed: null, outside: [], ownMention: false, missingContract: [], unmerged: [], dependents: [], staleDeps: [], correctedAfter: [], ...o });
const STALE = { id: 'C-050', superseders: ['C-051'], pending: [] as string[] };
const brief = (problem: string, f: Facts, e: Evidence): { cls: string; text: string } => {
  const cls = classifyProblem(problem, f);
  return { cls, text: briefing('o/r', ctx(), problem, cls, e, 3, []) };
};

describe('staleDepsOf', () => {
  it('rewrites a superseded dependency to its merged superseders', () => {
    const r = staleDepsOf(cells, 'C-070', new Set(['C-051', 'C-059']));
    expect(r.staleDeps).toEqual([STALE]);
    expect(r.correctedAfter).toEqual(['C-051', 'C-059']);
  });
  it('reports superseders that are not merged yet', () => {
    const r = staleDepsOf(cells, 'C-070', new Set(['C-059']));
    expect(r.staleDeps[0].pending).toEqual(['C-051']);
    expect(r.correctedAfter).toEqual(['C-051', 'C-059']);
  });
  it('ignores a superseded dependency that is already merged', () => {
    expect(staleDepsOf(cells, 'C-070', new Set(['C-050'])).staleDeps).toEqual([]);
  });
});

describe('stale_dependency', () => {
  const ev = EV({ staleDeps: [STALE], correctedAfter: ['C-051', 'C-059'] });
  it('is chosen for the gate message naming a superseded dependency', () => {
    const r = brief(GATE, F({ staleDeps: ['C-050'] }), ev);
    expect(r.cls).toBe('stale_dependency');
    expect(r.text).toContain('CLASS: stale_dependency');
    expect(r.text).toContain(head('cell_fix', 'replace'));
    expect(r.text).toContain('"after": ["C-051","C-059"]');
    expect(r.text).toContain(head('cell_signal', 'release'));
  });
  it('tells the chat to wait when the superseders are not merged', () => {
    const e = EV({ staleDeps: [{ ...STALE, pending: ['C-051'] }], correctedAfter: ['C-051', 'C-059'] });
    const r = brief(GATE, F({ staleDeps: ['C-050'] }), e);
    expect(r.text).toContain('C-051 are not merged yet: do not rework your files');
  });
  it('needs a superseded cell to be named', () => {
    expect(classifyProblem('dependencies not merged yet: C-099', F({ staleDeps: ['C-050'] }))).not.toBe('stale_dependency');
    expect(classifyProblem(GATE, F())).not.toBe('stale_dependency');
  });
});

describe('outside_cell', () => {
  const P = 'the CI gate rejected my submit again; all outputs already exist on the branch and the files are correct';
  it('is chosen when the chat says its outputs exist and a gate message fails', () => {
    const r = brief(P, F(), EV());
    expect(r.cls).toBe('outside_cell');
    expect(r.text).toContain('do not retry the same submit_cell');
    expect(r.text).toContain(head('cell_fix', 'blocker'));
    expect(r.text).toContain(head('cell_fix', 'replace'));
    expect(r.text).toContain(head('cell_signal', 'feedback'));
    expect(r.text).toContain('AT ONCE');
  });
  it('also trusts the outputsDone fact', () => {
    expect(classifyProblem('gate failed: check red', F({ outputsDone: true }))).toBe('outside_cell');
  });
  it('is not chosen without the claim that outputs exist', () => {
    expect(classifyProblem('CI gate failed in src/a.ts: assertion error', F({ ownMention: true }))).toBe('own_bug');
  });
});

describe('old classes', () => {
  it('own_bug stays and now mentions the repeat rule', () => {
    const r = brief('npm test fails in src/a.ts: assertion error', F({ ownMention: true }), EV({ ownMention: true }));
    expect(r.cls).toBe('own_bug');
    expect(r.text).toContain('repeats after one honest fix');
    expect(r.text).toContain('outside_cell');
  });
  it('keeps the other classes', () => {
    expect(classifyProblem('tests fail: cannot find module ./x', F({ behind: 2 }))).toBe('stale_branch');
    expect(classifyProblem('the contract is ambiguous', F())).toBe('spec_gap');
    expect(classifyProblem('apply_changes refused: outside allowed paths', F())).toBe('scope_violation');
    expect(classifyProblem('tests fail on main', F({ mainRed: true }))).toBe('broken_main');
    expect(classifyProblem('I am confused', F())).toBe('unknown');
  });
});

describe('briefing', () => {
  it('stays inside the size bound and holds no secrets', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `C-1${i}0`, superseders: [`C-2${i}0`, `C-3${i}0`], pending: [`C-2${i}0`] }));
    const e = EV({ staleDeps: many, correctedAfter: many.flatMap((s) => s.superseders) });
    for (const [p, f] of [[GATE, F({ staleDeps: ['C-050'] })], ['CI gate rejected; outputs already exist', F()]] as [string, Facts][]) {
      const text = brief(p + ' x'.repeat(400), f, e).text;
      expect(text.length).toBeLessThanOrEqual(BRIEFING_MAX_CHARS);
      expect(text).not.toMatch(/ghp_|github_pat_|admin_key/i);
    }
  });
});
