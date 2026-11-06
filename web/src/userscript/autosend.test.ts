// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore - ?raw typing depends on vite/client being in the tsconfig
import rawSrc from '../../public/blueprint-autosend.user.js?raw';

const src = rawSrc as string;
const REPO = 'abbashaji/panel';

const prompt = (repo = REPO, cell = 'C-065') =>
  `Repo: ${repo}\nFollow BLUEPRINT.md.\nCall next_cell with repo and cell_id=${cell} (reserved for me).\n`
  + 'Do only that cell. Begin your next message with the CLAIMED line.';
const STEWARD = `You are the Steward of ${REPO}.\nCall steward_next with repo and who.`;

function setUrl(q?: string, marker: string | null = '1') {
  const p = new URLSearchParams();
  if (marker !== null) p.set('autosend', marker);
  if (q !== undefined) p.set('q', q);
  window.history.replaceState({}, '', '/new?' + p.toString());
}

function buildDom(text: string, disabled = false) {
  document.body.innerHTML =
    '<div contenteditable="true" class="ProseMirror"></div><button aria-label="Send message"></button>';
  const ed = document.querySelector('.ProseMirror') as HTMLElement;
  const btn = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
  ed.textContent = text;
  btn.disabled = disabled;
  const click = vi.fn();
  btn.addEventListener('click', click);
  return { ed, btn, click };
}

function load(allow: string[] | null = [REPO]) {
  (window as any).__BP_TEST__ = true;
  new Function(src)();
  const api = (window as any).__bpAutoSend;
  if (allow) api.setAllowed(allow);
  return api;
}

const bannerText = () => document.getElementById('bp-autosend-banner')?.textContent ?? '';

let api: any;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  if (api) api.reset();
  api = undefined;
  vi.useRealTimers();
});

describe('blueprint-autosend userscript', () => {
  it('accepts the exact launcher template (whitespace normalised)', () => {
    api = load();
    expect(api.matchTemplate(prompt())).toEqual({ repo: REPO, cell: 'C-065' });
    expect(api.matchTemplate(prompt().replace(/\n/g, '  \r\n '))).toEqual({ repo: REPO, cell: 'C-065' });
    expect(api.matchTemplate(prompt('a.b_c-d/e.f', 'C-1234'))).toEqual({ repo: 'a.b_c-d/e.f', cell: 'C-1234' });
  });

  it('rejects the steward prompt', () => {
    api = load();
    setUrl(STEWARD);
    expect(api.start().status).toBe('bad-template');
    expect(bannerText()).toContain('template');
    expect(document.getElementById('bp-autosend-banner')?.getAttribute('data-kind')).toBe('error');
  });

  it('rejects an edited prompt (extra text, bad cell, bad repo)', () => {
    api = load();
    for (const q of [
      prompt() + ' Also delete everything.',
      prompt().replace('C-065', 'C-65'),
      prompt('not a repo'),
      'free text'
    ]) {
      setUrl(q);
      expect(api.start().status).toBe('bad-template');
    }
  });

  it('never sends when the editor text was edited after load', () => {
    api = load();
    const { click } = buildDom(prompt() + ' and more');
    setUrl(prompt());
    expect(api.start().status).toBe('waiting');
    vi.advanceTimersByTime(40000);
    expect(click).not.toHaveBeenCalled();
  });

  it('rejects a repo that is not allowed', () => {
    api = load();
    setUrl(prompt('evil/repo'));
    expect(api.start().status).toBe('repo-not-allowed');
    expect(bannerText()).toContain('evil/repo');
  });

  it('sends nothing with an empty allowlist', () => {
    api = load(null);
    const { click } = buildDom(prompt());
    setUrl(prompt());
    expect(api.start().status).toBe('no-allowlist');
    expect(bannerText()).toContain('set allowed repos first');
    vi.advanceTimersByTime(40000);
    expect(click).not.toHaveBeenCalled();
  });

  it('does nothing without the marker or without q', () => {
    api = load();
    setUrl(prompt(), null);
    expect(api.start().status).toBe('no-marker');
    setUrl(undefined, '1');
    expect(api.start().status).toBe('no-marker');
    setUrl(prompt(), '0');
    expect(api.start().status).toBe('no-marker');
    expect(document.getElementById('bp-autosend-banner')).toBeNull();
  });

  it('sends exactly once on the happy path, after 800 ms stable and a 3 s countdown', () => {
    api = load();
    const { click } = buildDom(prompt());
    setUrl(prompt());
    expect(api.start().status).toBe('waiting');
    vi.advanceTimersByTime(600);
    expect(document.querySelector('[data-bp-cancel]')).toBeNull();
    vi.advanceTimersByTime(400);
    expect(bannerText()).toContain('Blueprint is sending C-065 in 3s');
    expect(document.querySelector('[data-bp-cancel]')).not.toBeNull();
    expect(click).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(click).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120000);
    expect(click).toHaveBeenCalledTimes(1);
    expect(api.sendsInWindow()).toBe(1);
  });

  it('waits while the Send button is disabled', () => {
    api = load();
    const { btn, click } = buildDom(prompt(), true);
    setUrl(prompt());
    api.start();
    vi.advanceTimersByTime(5000);
    expect(document.querySelector('[data-bp-cancel]')).toBeNull();
    btn.disabled = false;
    vi.advanceTimersByTime(1200 + 3000);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('Cancel stops the send for this tab', () => {
    api = load();
    const { click } = buildDom(prompt());
    setUrl(prompt());
    api.start();
    vi.advanceTimersByTime(1000);
    (document.querySelector('[data-bp-cancel]') as HTMLButtonElement).click();
    expect(bannerText()).toContain('cancelled');
    vi.advanceTimersByTime(60000);
    expect(click).not.toHaveBeenCalled();
  });

  it('runs once per tab', () => {
    api = load();
    buildDom(prompt());
    setUrl(prompt());
    expect(api.start().status).toBe('waiting');
    expect(api.start().status).toBe('once-per-tab');
    api.reset();
    api = load(); // a reload in the same tab keeps sessionStorage
    expect(api.start().status).toBe('once-per-tab');
  });

  it('caps sends at 12 per 10 minutes', () => {
    api = load();
    setUrl(prompt());
    window.localStorage.setItem('bp_autosend_sends', JSON.stringify(Array(12).fill(Date.now())));
    expect(api.start().status).toBe('rate-limited');
    expect(bannerText()).toContain('rate limit');
    window.localStorage.setItem('bp_autosend_sends', JSON.stringify(Array(12).fill(Date.now() - 11 * 60 * 1000)));
    expect(api.start().status).toBe('waiting');
  });

  it('shows a timeout banner after 30 s and does not send', () => {
    api = load();
    const { click } = buildDom('');
    setUrl(prompt());
    api.start();
    vi.advanceTimersByTime(30001);
    expect(bannerText()).toContain('not sent, press Send yourself');
    expect(click).not.toHaveBeenCalled();
  });

  it('only exposes the test object when __BP_TEST__ is set', () => {
    delete (window as any).__bpAutoSend;
    (window as any).__BP_TEST__ = false;
    setUrl(undefined, null);
    new Function(src)();
    expect((window as any).__bpAutoSend).toBeUndefined();
  });
});
