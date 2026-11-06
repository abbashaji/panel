#!/usr/bin/env node
// End to end smoke test for the Blueprint Panel. Node 18+, no dependencies.
// Env: WORKER_URL, PANEL_PASSWORD, REPO (owner/name), optional ADMIN_KEY.
// Prints a PASS/FAIL/SKIP table and exits 1 on any FAIL. Never prints secrets.

const { WORKER_URL, PANEL_PASSWORD, REPO, ADMIN_KEY } = process.env;
const secrets = [PANEL_PASSWORD, ADMIN_KEY].filter((s) => s && s.length > 0);
const rows = [];
let cookie = '';

function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('***');
  const cv = cookie.split('=').slice(1).join('=');
  if (cv) out = out.split(cv).join('***');
  return out.replace(/\s+/g, ' ').slice(0, 160);
}
function add(name, status, detail) {
  rows.push({ name, status, detail: redact(detail || '') });
}
async function check(name, fn) {
  try {
    const r = await fn();
    add(name, r[0], r[1]);
    return r[0] === 'PASS';
  } catch (e) {
    add(name, 'FAIL', (e && e.message) || String(e));
    return false;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, limitMs, stepMs = 500) {
  const end = Date.now() + limitMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

function printTable() {
  const w = Math.max(5, ...rows.map((r) => r.name.length));
  console.log('\n' + 'CHECK'.padEnd(w) + '  RESULT  DETAIL');
  for (const r of rows) console.log(r.name.padEnd(w) + '  ' + r.status.padEnd(6) + '  ' + r.detail);
  const fails = rows.filter((r) => r.status === 'FAIL').length;
  const passes = rows.filter((r) => r.status === 'PASS').length;
  const skips = rows.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${passes} PASS, ${fails} FAIL, ${skips} SKIP`);
  process.exit(fails > 0 ? 1 : 0);
}

const missing = ['WORKER_URL', 'PANEL_PASSWORD', 'REPO'].filter((k) => !process.env[k]);
if (missing.length) {
  add('env', 'FAIL', 'missing env: ' + missing.join(', '));
  printTable();
}
const base = WORKER_URL.replace(/\/+$/, '');

async function api(path, { method = 'GET', body, withCookie = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (withCookie && cookie) headers.cookie = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}
const getState = () => api('/panel/api/state?repo=' + encodeURIComponent(REPO));
function setCookies(h) {
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const v = h.get('set-cookie');
  return v ? [v] : [];
}

const STATUSES = ['done', 'running', 'ready', 'waiting', 'expired', 'needs_human', 'needs_split'];
const COUNT_KEYS = ['done', 'running', 'ready', 'waiting', 'expired', 'needs_human', 'needs_split'];
let state = null;

await check('login', async () => {
  const r = await api('/panel/api/login', { method: 'POST', body: { password: PANEL_PASSWORD }, withCookie: false });
  if (r.status !== 200) return ['FAIL', 'HTTP ' + r.status];
  const c = setCookies(r.headers).find((x) => x.startsWith('bp_panel='));
  if (!c) return ['FAIL', 'no bp_panel cookie set'];
  cookie = c.split(';')[0];
  const flags = [/httponly/i, /secure/i, /samesite=strict/i];
  const bad = ['HttpOnly', 'Secure', 'SameSite=Strict'].filter((_, i) => !flags[i].test(c));
  add('cookie flags', bad.length ? 'FAIL' : 'PASS', bad.length ? 'missing ' + bad.join(', ') : 'HttpOnly, Secure, SameSite=Strict');
  return ['PASS', 'HTTP 200, cookie bp_panel set'];
});

await check('wrong password rejected', async () => {
  const r = await api('/panel/api/login', { method: 'POST', body: { password: 'wrong-password-e2e-smoke' }, withCookie: false });
  return r.status === 401 || r.status === 403 || r.status === 429 ? ['PASS', 'HTTP ' + r.status] : ['FAIL', 'HTTP ' + r.status];
});

await check('state needs cookie', async () => {
  const r = await api('/panel/api/state?repo=' + encodeURIComponent(REPO), { withCookie: false });
  return r.status === 401 ? ['PASS', 'HTTP 401'] : ['FAIL', 'HTTP ' + r.status];
});

await check('state shape', async () => {
  const r = await getState();
  if (r.status !== 200 || !r.json) return ['FAIL', 'HTTP ' + r.status];
  state = r.json;
  const p = [];
  if (state.repo !== REPO) p.push('repo mismatch');
  if (typeof state.project !== 'string') p.push('project');
  if (!/^[0-9a-f]{7,40}$/.test(String(state.mainSha))) p.push('mainSha');
  if (Number.isNaN(Date.parse(state.generatedAt))) p.push('generatedAt');
  if (!state.counts || typeof state.counts !== 'object') p.push('counts');
  if (!Array.isArray(state.cells)) p.push('cells');
  const b = state.bottleneck;
  if (b !== null && !(b && typeof b.id === 'string' && typeof b.blocks === 'number')) p.push('bottleneck');
  for (const c of Array.isArray(state.cells) ? state.cells : []) {
    const ok = typeof c.id === 'string' && typeof c.title === 'string' && STATUSES.includes(c.status) &&
      Array.isArray(c.depends) && Array.isArray(c.blockedBy) && typeof c.critical === 'boolean';
    if (!ok) { p.push('bad cell ' + c.id); break; }
  }
  return p.length ? ['FAIL', p.join(', ')] : ['PASS', state.cells.length + ' cells, project ' + state.project];
});

await check('counts match cells', async () => {
  if (!state) return ['SKIP', 'no state'];
  const p = [];
  let sum = 0;
  for (const k of COUNT_KEYS) {
    const n = state.counts[k];
    if (!Number.isInteger(n)) { p.push(k + ' not a number'); continue; }
    sum += n;
    const actual = state.cells.filter((c) => c.status === k).length;
    if (n !== actual) p.push(`${k} ${n} vs ${actual}`);
  }
  if (sum !== state.cells.length) p.push(`sum ${sum} vs ${state.cells.length} cells`);
  return p.length ? ['FAIL', p.join('; ')] : ['PASS', COUNT_KEYS.map((k) => k + '=' + state.counts[k]).join(' ')];
});

await check('replaced cells absent', async () => {
  if (!state) return ['SKIP', 'no state'];
  const odd = state.cells.filter((c) => !STATUSES.includes(c.status) || c.status === 'replaced');
  return odd.length ? ['FAIL', 'unexpected: ' + odd.map((c) => c.id + ':' + c.status).join(', ')] : ['PASS', 'no replaced or unknown status'];
});

await check('steward status field', async () => {
  if (!state) return ['SKIP', 'no state'];
  if (!('steward' in state)) return ['SKIP', 'state.steward not present (field not in panel-contracts.md; confirm its name)'];
  const s = state.steward;
  if (s === null) return ['PASS', 'steward null (none active)'];
  return s && typeof s.status === 'string' ? ['PASS', 'steward.status=' + s.status] : ['FAIL', 'steward has no string status'];
});

let target = null;
let before = null;
await check('reserve a ready cell', async () => {
  if (!state) return ['SKIP', 'no state'];
  const c = state.cells.find((x) => x.status === 'ready' && !x.reservedBy) || state.cells.find((x) => x.status === 'expired' && !x.reservedBy);
  if (!c) return ['SKIP', 'no ready cell to reserve'];
  const r = await api('/panel/api/reserve', { method: 'POST', body: { repo: REPO, cell_id: c.id, who: 'e2e-smoke' } });
  if (r.status !== 200 || !r.json || r.json.status !== 'reserved') return ['FAIL', `${c.id} HTTP ${r.status} ${r.text}`];
  target = c.id;
  before = c.status;
  return ['PASS', c.id + ' reserved'];
});

await check('reservedBy visible in 3 s', async () => {
  if (!target) return ['SKIP', 'nothing reserved'];
  const t0 = Date.now();
  const hit = await waitFor(async () => {
    const r = await getState();
    const c = r.json && r.json.cells && r.json.cells.find((x) => x.id === target);
    return c && c.reservedBy ? c : null;
  }, 3000);
  return hit ? ['PASS', `reservedBy set after ${Date.now() - t0} ms`] : ['FAIL', target + ' has no reservedBy after 3 s'];
});

await check('release then state updates in 10 s', async () => {
  if (!target) return ['SKIP', 'nothing reserved'];
  if (!ADMIN_KEY) return ['SKIP', 'ADMIN_KEY not set; reservation expires by itself after 600 s'];
  const r = await api('/panel/api/release', { method: 'POST', body: { repo: REPO, cell_id: target, admin_key: ADMIN_KEY } });
  if (r.status !== 200) return ['FAIL', 'release HTTP ' + r.status + ' ' + r.text];
  const t0 = Date.now();
  let seen = null;
  const ok = await waitFor(async () => {
    const s = await getState();
    const c = s.json && s.json.cells && s.json.cells.find((x) => x.id === target);
    seen = c;
    return c && !c.reservedBy && STATUSES.includes(c.status) ? c : null;
  }, 10000);
  return ok ? ['PASS', `${target} status ${before} -> ${ok.status}, no reservedBy after ${Date.now() - t0} ms`] : ['FAIL', `${target} still reservedBy=${seen && seen.reservedBy} after 10 s`];
});

printTable();
