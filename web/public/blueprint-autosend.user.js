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
