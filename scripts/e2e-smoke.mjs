#!/usr/bin/env node
// End to end smoke test for the Blueprint Panel. Node 18+, no dependencies.
// Env: WORKER_URL, PANEL_PASSWORD, REPO (owner/name). Optional: ADMIN_KEY, CELL_ID, REPLACED_IDS, STEWARD_FIELD.
// Prints a PASS / FAIL / SKIP table and exits 1 on any FAIL. Never prints secrets.
// Contract after C-069: releasing a cell that was only reserved answers UNRESERVED, releasing a running cell answers RELEASED;
// in both cases the next state has no reservedBy. state.steward.status is one of none, active, expired, released.

const WORKER_URL = (process.env.WORKER_URL || '').trim().replace(/\/+$/, '');
const PASSWORD = process.env.PANEL_PASSWORD || '';
const REPO = (process.env.REPO || '').trim();
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PIN_CELL = (process.env.CELL_ID || '').trim();
const STEWARD_FIELD = (process.env.STEWARD_FIELD || 'steward').trim();
const REPLACED = (process.env.REPLACED_IDS || 'C-052,C-058')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WHO = 'e2e-smoke';
const STATUSES = ['done', 'running', 'ready', 'waiting', 'expired', 'needs_human', 'needs_split'];
const AFTER_RELEASE = ['ready', 'expired', 'waiting'];
const STEWARD_STATUSES = ['none', 'active', 'expired', 'released'];

const rows = [];
let cookie = '';

function clean(value) {
  let text = String(value);
  for (const secret of [PASSWORD, ADMIN_KEY, cookie]) {
    if (secret && secret.length >= 3) text = text.split(secret).join('***');
  }
  return text.replace(/\s+/g, ' ').slice(0, 160);
}
function record(name, status, detail = '') {
  rows.push({ name, status, detail: clean(detail) });
}
const pass = (detail = '') => ({ status: 'PASS', detail });
const fail = (detail = '') => ({ status: 'FAIL', detail });
const skip = (detail = '') => ({ status: 'SKIP', detail });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

async function step(name, fn) {
  try {
    const out = await fn();
    if (out) record(name, out.status, out.detail);
  } catch (err) {
    record(name, 'FAIL', err && err.message ? err.message : err);
  }
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && cookie) headers.cookie = cookie;
  const res = await fetch(WORKER_URL + path, {
    method,
    headers,
    redirect: 'manual',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, res };
}

const statePath = () => '/panel/api/state?repo=' + encodeURIComponent(REPO);

async function getState() {
  const r = await call(statePath());
  if (r.status !== 200 || !isObj(r.json)) throw new Error('state request failed, HTTP ' + r.status);
  return r.json;
}

async function waitFor(test, limitMs, everyMs = 500) {
  const start = Date.now();
  for (;;) {
    const state = await getState();
    const seconds = (Date.now() - start) / 1000;
    if (test(state)) return { ok: true, state, seconds };
    if (Date.now() - start >= limitMs) return { ok: false, state, seconds };
    await sleep(everyMs);
  }
}

function shapeProblems(s) {
  const bad = [];
  if (s.repo !== REPO) bad.push('repo is not ' + REPO);
  for (const k of ['project', 'mainSha', 'generatedAt']) {
    if (typeof s[k] !== 'string' || !s[k]) bad.push(k + ' missing');
  }
  if (typeof s.generatedAt === 'string' && Number.isNaN(Date.parse(s.generatedAt))) bad.push('generatedAt not a date');
  if (!isObj(s.counts)) bad.push('counts missing');
  else for (const k of STATUSES) if (!Number.isInteger(s.counts[k])) bad.push('counts.' + k);
  if (!Array.isArray(s.cells)) return bad.concat('cells missing');
  for (const c of s.cells) {
    if (!isObj(c) || typeof c.id !== 'string') {
      bad.push('cell without id');
      continue;
    }
    if (!STATUSES.includes(c.status)) bad.push(c.id + ' has status ' + c.status);
    if (!Array.isArray(c.depends) || !Array.isArray(c.blockedBy)) bad.push(c.id + ' depends/blockedBy');
    if (typeof c.critical !== 'boolean') bad.push(c.id + ' critical');
  }
  const b = s.bottleneck;
  if (b !== null && !(isObj(b) && typeof b.id === 'string' && Number.isInteger(b.blocks))) bad.push('bottleneck');
  return bad.slice(0, 5);
}

function countDiffs(s) {
  const tally = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  for (const c of s.cells) if (c.status in tally) tally[c.status] += 1;
  return STATUSES.filter((k) => tally[k] !== s.counts[k]).map((k) => k + ' counts=' + s.counts[k] + ' cells=' + tally[k]);
}

function printTable() {
  const width = Math.max(5, ...rows.map((r) => r.name.length));
  console.log('\n' + 'CHECK'.padEnd(width) + '  RESULT  DETAIL');
  for (const r of rows) console.log(r.name.padEnd(width) + '  ' + r.status.padEnd(6) + '  ' + r.detail);
  const n = (s) => rows.filter((r) => r.status === s).length;
  console.log('\n' + n('PASS') + ' PASS, ' + n('FAIL') + ' FAIL, ' + n('SKIP') + ' SKIP');
  process.exitCode = n('FAIL') > 0 ? 1 : 0;
}

async function main() {
  const missing = [['WORKER_URL', WORKER_URL], ['PANEL_PASSWORD', PASSWORD], ['REPO', REPO]]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error('Missing environment variables: ' + missing.join(', '));
    process.exit(2);
  }
  if (!/^https?:\/\/[^\s/]+/.test(WORKER_URL) || !/^[\w.-]+\/[\w.-]+$/.test(REPO)) {
    console.error('WORKER_URL must start with http(s):// and REPO must look like owner/name');
    process.exit(2);
  }
  console.log('Smoke test: ' + new URL(WORKER_URL).host + ' repo ' + REPO + (ADMIN_KEY ? ' (admin checks on)' : ' (no ADMIN_KEY: release checks skipped)'));

  await step('unauthenticated state is refused', async () => {
    const r = await call(statePath(), { auth: false });
    return r.status === 401 ? pass('HTTP 401') : fail('expected 401, got ' + r.status);
  });

  let loggedIn = false;
  await step('login', async () => {
    const r = await call('/panel/api/login', { method: 'POST', body: { password: PASSWORD }, auth: false });
    if (r.status !== 200) return fail('HTTP ' + r.status);
    const h = r.res.headers;
    const list = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [h.get('set-cookie') || ''];
    const all = list.join('; ');
    const m = all.match(/bp_panel=[^;,\s]+/);
    if (!m) return fail('no bp_panel cookie');
    cookie = m[0];
    loggedIn = true;
    const flags = ['HttpOnly', 'Secure', 'SameSite=Strict'].filter((f) => !new RegExp(f, 'i').test(all));
    record('cookie flags', flags.length ? 'FAIL' : 'PASS', flags.length ? 'missing ' + flags.join(', ') : 'HttpOnly Secure SameSite=Strict');
    return pass('HTTP 200');
  });
  if (!loggedIn) return;

  let state = null;
  await step('state shape', async () => {
    state = await getState();
    const bad = shapeProblems(state);
    return bad.length ? fail(bad.join('; ')) : pass(state.cells.length + ' cells, main ' + state.mainSha);
  });
  if (!state || !Array.isArray(state.cells) || !isObj(state.counts)) return;

  await step('counts match cells', async () => {
    const diffs = countDiffs(state);
    return diffs.length ? fail(diffs.join('; ')) : pass(STATUSES.map((k) => k + '=' + state.counts[k]).join(' '));
  });

  await step('replaced cells absent', async () => {
    const ids = new Set(state.cells.map((c) => c.id));
    const present = REPLACED.filter((id) => ids.has(id));
    return present.length ? fail('still listed: ' + present.join(', ')) : pass('checked ' + (REPLACED.join(', ') || 'none'));
  });

  await step('steward.status is valid', async () => {
    const v = state[STEWARD_FIELD];
    if (v === undefined) return fail('state.' + STEWARD_FIELD + ' missing (set STEWARD_FIELD if named differently)');
    if (v === null) return fail('state.' + STEWARD_FIELD + ' is null, expected an object with status ' + STEWARD_STATUSES.join(', '));
    if (!isObj(v) || typeof v.status !== 'string') return fail('state.' + STEWARD_FIELD + ' has no string status');
    return STEWARD_STATUSES.includes(v.status) ? pass('status ' + v.status) : fail('status ' + v.status + ' is not one of ' + STEWARD_STATUSES.join(', '));
  });

  const firstReady = state.cells.find((c) => c.status === 'ready');
  const targetCell = PIN_CELL ? state.cells.find((c) => c.id === PIN_CELL) : firstReady;
  const target = PIN_CELL || (firstReady || {}).id;
  const cellOf = (s) => s.cells.find((c) => c.id === target);
  let reserved = false;
  await step('reserve a ready cell', async () => {
    if (!target || !targetCell) return skip(PIN_CELL ? PIN_CELL + ' is not in the state' : 'no ready cell, and reserve needs one (publish the sample plan or wait until a cell is ready)');
    if (targetCell.status !== 'ready') return skip(target + ' is ' + targetCell.status + ', not ready');
    const r = await call('/panel/api/reserve', { method: 'POST', body: { repo: REPO, cell_id: target, who: WHO } });
    const status = isObj(r.json) ? r.json.status : undefined;
    if (r.status === 200 && status === 'reserved') {
      reserved = true;
      return pass(target + ' reserved');
    }
    if (/not_ready/i.test(String(status))) return skip(target + ' was no longer ready (' + status + ')');
    return fail('HTTP ' + r.status + ' status ' + status + ' for ' + target);
  });

  await step('state shows reservedBy within 3 s', async () => {
    if (!reserved) return skip('nothing reserved');
    const w = await waitFor((s) => Boolean(cellOf(s) && cellOf(s).reservedBy), 3000);
    return w.ok ? pass('after ' + w.seconds.toFixed(1) + ' s') : fail('reservedBy still empty after 3 s');
  });

  let released = false;
  await step('release (admin)', async () => {
    if (!ADMIN_KEY) return skip('ADMIN_KEY not set');
    if (!reserved) return skip('this script reserved nothing, so there is nothing to release');
    const before = cellOf(await getState());
    const expected = before && before.status === 'running' ? 'RELEASED' : 'UNRESERVED';
    const r = await call('/panel/api/release', { method: 'POST', body: { repo: REPO, cell_id: target, admin_key: ADMIN_KEY } });
    if (r.status !== 200) return fail('HTTP ' + r.status);
    released = true;
    const answer = isObj(r.json) && typeof r.json.status === 'string' ? r.json.status : '';
    return answer.toUpperCase() === expected ? pass(answer + ' for ' + target) : fail('expected ' + expected + ', got ' + (answer || 'no status') + ' for ' + target);
  });

  await step('state shows no reservedBy and new status within 10 s', async () => {
    if (!released) return skip('release did not run or failed');
    const w = await waitFor((s) => {
      const c = cellOf(s);
      return Boolean(c) && !c.reservedBy && AFTER_RELEASE.includes(c.status);
    }, 10000);
    const c = cellOf(w.state);
    const now = c ? 'status ' + c.status + ', reservedBy ' + (c.reservedBy || 'none') : target + ' not in state';
    return w.ok ? pass(now + ' after ' + w.seconds.toFixed(1) + ' s') : fail(now + ' after 10 s');
  });
}

main()
  .catch((err) => record('unexpected error', 'FAIL', err && err.message ? err.message : err))
  .finally(() => {
    if (rows.length) printTable();
  });
