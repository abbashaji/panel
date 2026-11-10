import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEFING_MAX_CHARS, briefing, classifyProblem, staleDepsOf, type Ctx, type Evidence, type Facts } from '../src/selfheal.ts';

const q = JSON.stringify;
const head = (tool: string, kind: string): string => `${tool}(repo=${q('o/r')}, cell_id=${q('C-070')}, base=${q('c231e07')}, kind=${q(kind)}`;
const GATE = 'dependencies not merged yet: C-004';

const cells: Record<string, any> = {
  'C-004': { id: 'C-004', title: 'old', goal: 'g' },
  'C-051': { id: 'C-051', title: 'new', goal: 'g', supersedes: ['C-004'] },
  'C-059': { id: 'C-059', title: 'other', goal: 'g' },
  'C-070': { id: 'C-070', title: 'heal', goal: 'goal text', after: ['C-004', 'C-059'], allowed_paths: ['src/a.ts'], outputs: ['src/a.ts'], acceptance: [{ cmd: 'npm test' }] },
};
const F = (o: Partial<Facts> = {}): Facts => ({ behind: 0, outside: [], ownMention: false, mainRed: false, missingContract: false, ...o });
const ctx = (): Ctx => ({ id: 'C-070', snap: {} as any, plan: { cells } as any, branch: { oid: 'c231e07aaaa', message: 'cell(C-070): claim' } as any });
const EV = (o: Partial<Evidence> = {}): Evidence => ({ behind: 0, ahead: 0, mainRed: null, outside: [], ownOutside: [], ownMention: false, missingContract: [], unmerged: [], dependents: [], staleDeps: [], correctedAfter: [], ...o });
const STALE = { id: 'C-004', superseders: ['C-051'], pending: [] as string[] };
const brief = (problem: string, f: Facts, e: Evidence): { cls: string; text: string } => {
  const cls = classifyProblem(problem, f);
  return { cls, text: briefing('o/r', ctx(), problem, cls, e, 3, []) };
};

describe('staleDepsOf', () => {
  test('rewrites a superseded dependency to its merged superseders', () => {
    const r = staleDepsOf(cells, 'C-070', new Set(['C-051', 'C-059']));
    assert.deepEqual(r.staleDeps, [STALE]);
    assert.deepEqual(r.correctedAfter, ['C-051', 'C-059']);
  });
  test('reports superseders that are not merged yet', () => {
    const r = staleDepsOf(cells, 'C-070', new Set(['C-059']));
    assert.deepEqual(r.staleDeps[0].pending, ['C-051']);
    assert.deepEqual(r.correctedAfter, ['C-051', 'C-059']);
  });
  test('ignores a superseded dependency that is already merged', () => {
    assert.deepEqual(staleDepsOf(cells, 'C-070', new Set(['C-004'])).staleDeps, []);
  });
});

describe('stale_dependency', () => {
  const ev = EV({ staleDeps: [STALE], correctedAfter: ['C-051', 'C-059'] });
  test('is chosen for the gate message naming a superseded dependency', () => {
    const r = brief(GATE, F({ staleDeps: ['C-004'] }), ev);
    assert.equal(r.cls, 'stale_dependency');
    assert.ok(r.text.includes('CLASS: stale_dependency'));
    assert.ok(r.text.includes(head('cell_fix', 'replace')));
    assert.ok(r.text.includes('"after": ["C-051","C-059"]'));
    assert.ok(r.text.includes(head('cell_signal', 'release')));
  });
  test('tells the chat to wait when the superseders are not merged', () => {
    const e = EV({ staleDeps: [{ ...STALE, pending: ['C-051'] }], correctedAfter: ['C-051', 'C-059'] });
    const r = brief(GATE, F({ staleDeps: ['C-004'] }), e);
    assert.ok(r.text.includes('C-051 are not merged yet: do not rework your files'));
  });
  test('needs a superseded cell to be named', () => {
    assert.notEqual(classifyProblem('dependencies not merged yet: C-099', F({ staleDeps: ['C-004'] })), 'stale_dependency');
    assert.notEqual(classifyProblem(GATE, F()), 'stale_dependency');
  });
});

describe('outside_cell', () => {
  const P = 'the CI gate rejected my submit again; all outputs already exist on the branch and the files are correct';
  test('is chosen when the chat says its outputs exist and a gate message fails', () => {
    const r = brief(P, F(), EV());
    assert.equal(r.cls, 'outside_cell');
    assert.ok(r.text.includes('do not retry the same submit_cell'));
    assert.ok(r.text.includes(head('cell_fix', 'blocker')));
    assert.ok(r.text.includes(head('cell_fix', 'replace')));
    assert.ok(r.text.includes(head('cell_signal', 'feedback')));
    assert.ok(r.text.includes('AT ONCE'));
  });
  test('also trusts the outputsDone fact', () => {
    assert.equal(classifyProblem('gate failed: check red', F({ outputsDone: true })), 'outside_cell');
  });
  test('is not chosen without the claim that outputs exist', () => {
    assert.equal(classifyProblem('CI gate failed in src/a.ts: assertion error', F({ ownMention: true })), 'own_bug');
  });
});

describe('old classes', () => {
  test('own_bug stays and now mentions the repeat rule', () => {
    const r = brief('npm test fails in src/a.ts: assertion error', F({ ownMention: true }), EV({ ownMention: true }));
    assert.equal(r.cls, 'own_bug');
    assert.ok(r.text.includes('repeats after one honest fix'));
    assert.ok(r.text.includes('outside_cell'));
  });
  test('keeps the other classes', () => {
    assert.equal(classifyProblem('tests fail: cannot find module ./x', F({ behind: 2 })), 'stale_branch');
    assert.equal(classifyProblem('the contract is ambiguous', F()), 'spec_gap');
    assert.equal(classifyProblem('apply_changes refused: outside allowed paths', F()), 'scope_violation');
    assert.equal(classifyProblem('tests fail on main', F({ mainRed: true })), 'broken_main');
    assert.equal(classifyProblem('I am confused', F()), 'unknown');
  });
});

describe('briefing', () => {
  test('stays inside the size bound and holds no secrets', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `C-1${i}0`, superseders: [`C-2${i}0`, `C-3${i}0`], pending: [`C-2${i}0`] }));
    const e = EV({ staleDeps: many, correctedAfter: many.flatMap((s) => s.superseders) });
    for (const [p, f] of [[GATE, F({ staleDeps: ['C-004'] })], ['CI gate rejected; outputs already exist', F()]] as [string, Facts][]) {
      const text = brief(p + ' x'.repeat(400), f, e).text;
      assert.ok(text.length <= BRIEFING_MAX_CHARS);
      assert.doesNotMatch(text, /ghp_|github_pat_|admin_key/i);
    }
  });
});

describe('own deliverables outside allowed_paths (C-081)', () => {
  const own = EV({ outside: ['package.json'], ownOutside: ['package.json'], correctedAfter: ['C-051', 'C-059'] });
  const firstLine = (text: string): string => text.split('\n').find((l) => l.startsWith('1. '))!;
  test('scope_violation starts with replace, widened by the own path only, then the handoff', () => {
    const r = brief('I need to edit package.json', F({ outside: ['package.json'] }), own);
    assert.equal(r.cls, 'scope_violation');
    const first = firstLine(r.text);
    assert.ok(first.startsWith(`1. ${head('cell_fix', 'replace')}`), first);
    assert.ok(first.includes('"allowed_paths": ["src/a.ts","package.json"]'), first);
    assert.ok(first.includes('"outputs": ["src/a.ts","package.json"]'), first);
    assert.ok(first.includes('"after": ["C-051","C-059"]'), first);
    assert.ok(r.text.includes(`2. then hand off (use the base the cell_fix answer returns): ${head('cell_signal', 'release')}`));
    assert.ok(r.text.includes('fresh chat'));
    assert.ok(r.text.includes(head('cell_fix', 'blocker')));
    assert.ok(r.text.includes(head('cell_signal', 'feedback')));
  });
  test('without an own path the replace is not offered', () => {
    const r = brief('I need to edit package.json', F({ outside: ['package.json'] }), EV({ outside: ['package.json'] }));
    assert.equal(r.cls, 'scope_violation');
    assert.ok(firstLine(r.text).startsWith('1. never write outside allowed_paths'));
    assert.ok(!r.text.includes(head('cell_fix', 'replace')));
  });
  test('outside_cell offers the replace first for an own deliverable and keeps the blocker for other files', () => {
    const P = 'the CI gate rejected my submit again; all outputs already exist on the branch and the files are correct; package.json is missing';
    const r = brief(P, F({ outside: ['package.json'] }), own);
    assert.equal(r.cls, 'scope_violation');
    const r2 = brief(P, F(), own);
    assert.equal(r2.cls, 'outside_cell');
    assert.ok(firstLine(r2.text).startsWith(`1. ${head('cell_fix', 'replace')}`));
    assert.ok(r2.text.includes('do not retry the same submit_cell'));
    assert.ok(r2.text.includes(head('cell_fix', 'blocker')));
    assert.ok(r2.text.includes('not your own deliverable'));
  });
  test('spec_gap forbids stopping after only a note', () => {
    const r = brief('the contract is ambiguous', F(), EV());
    assert.equal(r.cls, 'spec_gap');
    assert.ok(r.text.includes('never stop after only a note'));
    assert.ok(r.text.includes('AND keep working on the cell'));
    assert.ok(r.text.includes('A note alone leaves the cell running and nobody sees it'));
  });
  test('the briefing stays inside the size bound with own paths', () => {
    const many = Array.from({ length: 6 }, (_, i) => `scripts/tool_with_a_long_name_${i}.mjs`);
    const e = EV({ outside: many, ownOutside: many, correctedAfter: ['C-051', 'C-059'] });
    const text = brief('apply_changes refused: outside allowed paths ' + 'x '.repeat(400), F({ outside: many }), e).text;
    assert.ok(text.length <= BRIEFING_MAX_CHARS, `${text.length}`);
  });
});
