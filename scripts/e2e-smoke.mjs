#!/usr/bin/env node
// End to end smoke test for the Blueprint Panel. Node 18+, no dependencies.
// Env: WORKER_URL, PANEL_PASSWORD, REPO (owner/name). Optional: ADMIN_KEY, CELL_ID, REPLACED_IDS, STEWARD_FIELD.
// Prints a PASS / FAIL / SKIP table and exits 1 on any FAIL. Never prints secrets.

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
