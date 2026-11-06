// ADJUST ONCE: replace PANEL_HOST below with the host that serves the panel.
// Both URLs use the path the panel serves: /panel/blueprint-autosend.user.js
// ==UserScript==
// @name         Blueprint auto-send
// @namespace    blueprint
// @version      1.0.0
// @description  Clicks Send for a strictly matched Blueprint launcher prompt on claude.ai/new
// @match        https://claude.ai/new*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @updateURL    https://PANEL_HOST/panel/blueprint-autosend.user.js
// @downloadURL  https://PANEL_HOST/panel/blueprint-autosend.user.js
// ==/UserScript==
(function () {
  'use strict';

  // ---- CONFIG: the only place with page selectors and limits ----
  var CONFIG = {
    editorSelectors: [
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]',
      'textarea'
    ],
    sendSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]'
    ],
    pollMs: 200,
    stableMs: 800,
    countdownMs: 3000,
    timeoutMs: 30000,
    maxSends: 12,
    windowMs: 10 * 60 * 1000,
    keyAllowed: 'bp_allowed_repos',
    keySends: 'bp_autosend_sends',
    keyTab: 'bp_autosend_tab_done',
    bannerId: 'bp-autosend-banner'
  };

  // Exactly the launcher cell template (launcher/Core/PromptBuilder.cs BuildPrompt),
  // compared after whitespace normalisation. Nothing else is ever sent.
  var TEMPLATE = /^Repo: ([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+) Follow BLUEPRINT\.md\. Call next_cell with repo and cell_id=(C-\d{3,}) \(reserved for me\)\. Do only that cell\. Begin your next message with the CLAIMED line\.$/;
  var REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

  var api = {};
  var state = null;
  var memTab = false;

  api.config = CONFIG;

  api.normalize = function (s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  };
  api.squash = function (s) {
    return String(s == null ? '' : s).replace(/\s+/g, '');
  };

  // Returns {repo, cell} for the exact template, else null.
  api.matchTemplate = function (q) {
    var m = TEMPLATE.exec(api.normalize(q));
    return m ? { repo: m[1], cell: m[2] } : null;
  };

  // ---- storage: GM_* when present, localStorage fallback, always guarded ----
  api.storeGet = function (key, def) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, def);
    } catch (e) { /* fall through */ }
    try {
      var raw = window.localStorage.getItem(key);
      return raw === null ? def : JSON.parse(raw);
    } catch (e) { /* fall through */ }
    return def;
  };
  api.storeSet = function (key, value) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, value); return true; }
    } catch (e) { /* fall through */ }
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) { /* fall through */ }
    return false;
  };

  // ---- allowed repos ----
  api.getAllowed = function () {
    var v = api.storeGet(CONFIG.keyAllowed, '');
    if (typeof v !== 'string') return [];
    return v.split(',').map(function (s) { return s.trim().toLowerCase(); })
      .filter(function (s) { return REPO_RE.test(s); });
  };
  api.setAllowed = function (list) {
    var clean = [];
    (list || []).forEach(function (s) {
      s = String(s).trim().toLowerCase();
      if (REPO_RE.test(s) && clean.indexOf(s) < 0) clean.push(s);
    });
    api.storeSet(CONFIG.keyAllowed, clean.join(','));
    return clean;
  };
  api.promptAllowedRepos = function () {
    var v = window.prompt('Allowed repos (owner/name, comma separated):', api.getAllowed().join(', '));
    if (v === null) return;
    api.setAllowed(v.split(','));
  };

  // ---- once per tab ----
  api.tabDone = function () {
    try { return window.sessionStorage.getItem(CONFIG.keyTab) === '1'; } catch (e) { return memTab; }
  };
  api.markTab = function () {
    memTab = true;
    try { window.sessionStorage.setItem(CONFIG.keyTab, '1'); } catch (e) { /* memTab covers it */ }
  };

  // ---- rate cap: at most maxSends in windowMs, stored count ----
  api.recentSends = function () {
    var v = api.storeGet(CONFIG.keySends, []);
    var now = Date.now();
    if (!Array.isArray(v)) return [];
    return v.filter(function (t) { return typeof t === 'number' && now - t < CONFIG.windowMs && t <= now; });
  };
  api.sendsInWindow = function () { return api.recentSends().length; };
  api.recordSend = function () {
    var v = api.recentSends();
    v.push(Date.now());
    api.storeSet(CONFIG.keySends, v);
  };

  // ---- page access ----
  function firstMatch(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }
  api.editorEl = function () { return firstMatch(CONFIG.editorSelectors); };
  api.sendBtn = function () { return firstMatch(CONFIG.sendSelectors); };
  api.editorText = function (el) {
    if (!el) return '';
    if (typeof el.value === 'string') return el.value;
    return typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
  };

  // ---- banner ----
  api.banner = function (text, kind, withCancel) {
    var old = document.getElementById(CONFIG.bannerId);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = CONFIG.bannerId;
    box.setAttribute('role', 'status');
    box.setAttribute('data-kind', kind);
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;'
      + 'font:14px/1.4 system-ui,sans-serif;color:#fff;display:flex;gap:12px;align-items:center;'
      + 'background:' + (kind === 'error' ? '#b00020' : '#1f4e79') + ';';
    var span = document.createElement('span');
    span.textContent = text;
    box.appendChild(span);
    if (withCancel) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-bp-cancel', '1');
      b.textContent = 'Cancel';
      b.addEventListener('click', api.cancel);
      box.appendChild(b);
    }
    (document.body || document.documentElement).appendChild(box);
    return box;
  };

  // ---- run loop ----
  api.clearTimers = function () {
    if (!state) return;
    if (state.poll) clearInterval(state.poll);
    if (state.fire) clearTimeout(state.fire);
    if (state.timeout) clearTimeout(state.timeout);
    state.poll = state.fire = state.timeout = null;
  };
  api.getState = function () { return state; };
  api.reset = function () {
    api.clearTimers();
    state = null;
    memTab = false;
    var old = document.getElementById(CONFIG.bannerId);
    if (old && old.parentNode) old.parentNode.removeChild(old);
  };

  api.isReady = function () {
    var ed = api.editorEl();
    var btn = api.sendBtn();
    if (!state || !ed || !btn) return false;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
    return api.squash(api.editorText(ed)) === api.squash(state.prompt);
  };

  api.tick = function () {
    if (!state || state.phase !== 'waiting') return;
    if (!api.isReady()) { state.readySince = null; return; }
    if (state.readySince === null) { state.readySince = Date.now(); return; }
    if (Date.now() - state.readySince >= CONFIG.stableMs) api.beginCountdown();
  };

  api.beginCountdown = function () {
    if (!state || state.phase !== 'waiting') return;
    state.phase = 'countdown';
    if (state.poll) { clearInterval(state.poll); state.poll = null; }
    api.banner('Blueprint is sending ' + state.cell + ' in ' + (CONFIG.countdownMs / 1000) + 's', 'info', true);
    state.fire = setTimeout(api.fire, CONFIG.countdownMs);
  };

  api.fire = function () {
    if (!state || state.phase !== 'countdown') return;
    state.fire = null;
    if (!api.isReady()) {
      // page changed during the countdown: go back to waiting, never click blindly
      state.phase = 'waiting';
      state.readySince = null;
      state.poll = setInterval(api.tick, CONFIG.pollMs);
      api.banner('Blueprint auto-send: waiting for the editor...', 'info');
      return;
    }
    var btn = api.sendBtn();
    state.phase = 'done';
    api.clearTimers();
    api.recordSend();
    btn.click();
    api.banner('Blueprint sent ' + state.cell + '.', 'info');
  };

  api.cancel = function () {
    if (!state || state.phase === 'done') return;
    api.clearTimers();
    state.phase = 'cancelled';
    api.banner('Blueprint auto-send cancelled for this tab.', 'info');
  };

  api.onTimeout = function () {
    if (!state || state.phase === 'done' || state.phase === 'cancelled') return;
    api.clearTimers();
    state.phase = 'timeout';
    api.banner('Blueprint auto-send: not sent, press Send yourself.', 'error');
  };

  // ---- entry: everything is captured once here ----
  api.start = function () {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return { status: 'no-marker' }; }
    var q = params.get('q');
    if (params.get('autosend') !== '1' || q === null || q === '') return { status: 'no-marker' };

    var m = api.matchTemplate(q);
    if (!m) {
      api.banner('Blueprint auto-send: not sent, the prompt does not match the launcher cell template.', 'error');
      return { status: 'bad-template' };
    }
    var allowed = api.getAllowed();
    if (!allowed.length) {
      api.banner('Blueprint auto-send: not sent, set allowed repos first.', 'error');
      return { status: 'no-allowlist' };
    }
    if (allowed.indexOf(m.repo.toLowerCase()) < 0) {
      api.banner('Blueprint auto-send: not sent, ' + m.repo + ' is not in the allowed repos.', 'error');
      return { status: 'repo-not-allowed' };
    }
    if (api.tabDone()) {
      api.banner('Blueprint auto-send: already handled once in this tab.', 'error');
      return { status: 'once-per-tab' };
    }
    if (api.sendsInWindow() >= CONFIG.maxSends) {
      api.banner('Blueprint auto-send: not sent, rate limit reached (' + CONFIG.maxSends + ' per 10 minutes).', 'error');
      return { status: 'rate-limited' };
    }

    api.markTab();
    state = {
      prompt: api.normalize(q), cell: m.cell, repo: m.repo,
      phase: 'waiting', readySince: null, poll: null, fire: null, timeout: null
    };
    state.poll = setInterval(api.tick, CONFIG.pollMs);
    state.timeout = setTimeout(api.onTimeout, CONFIG.timeoutMs);
    api.banner('Blueprint auto-send: waiting for the editor...', 'info');
    return { status: 'waiting', cell: m.cell, repo: m.repo };
  };

  if (typeof GM_registerMenuCommand === 'function') {
    try { GM_registerMenuCommand('Blueprint auto-send: set allowed repos', api.promptAllowedRepos); } catch (e) { /* menu optional */ }
  }

  if (window.__BP_TEST__) {
    window.__bpAutoSend = api;
  } else {
    api.start();
  }
})();
