import { useCallback, useEffect, useState } from "react";
import { readStore, writeStore } from "../core/storage";

export type PanelName = "sidebar" | "inspector" | "activity";
export type PanelVisibility = Record<PanelName, boolean>;

/** localStorage key; value is JSON {sidebar, inspector, activity} booleans (true = visible). */
export const PANELS_KEY = "bp_panels";
const NAMES: PanelName[] = ["sidebar", "inspector", "activity"];
const DEFAULTS: PanelVisibility = { sidebar: true, inspector: true, activity: true };

function load(): PanelVisibility {
  const out: PanelVisibility = { ...DEFAULTS };
  const raw = readStore(PANELS_KEY);
  if (!raw) return out;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object") {
      for (const n of NAMES) {
        const x = (v as Record<string, unknown>)[n];
        if (typeof x === "boolean") out[n] = x;
      }
    }
  } catch {
    /* corrupt value: keep the defaults */
  }
  return out;
}

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/**
 * Visibility of the three shell panels, persisted in localStorage.
 * Shortcuts: Ctrl+B sidebar, Ctrl+Alt+I inspector, Ctrl+J activity (ignored while typing in a field).
 */
export function usePanelVisibility() {
  const [visible, setVisible] = useState<PanelVisibility>(load);

  const update = useCallback((name: PanelName, f: (cur: boolean) => boolean) => {
    setVisible((prev) => {
      const value = f(prev[name]);
      if (value === prev[name]) return prev;
      const next = { ...prev, [name]: value };
      writeStore(PANELS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const toggle = useCallback((name: PanelName) => update(name, (v) => !v), [update]);
  const show = useCallback((name: PanelName) => update(name, () => true), [update]);
  const hide = useCallback((name: PanelName) => update(name, () => false), [update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      let name: PanelName | null = null;
      if (e.altKey) {
        if (k === "i" || e.code === "KeyI") name = "inspector";
      } else if (k === "b") name = "sidebar";
      else if (k === "j") name = "activity";
      if (!name) return;
      e.preventDefault();
      toggle(name);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { visible, toggle, show, hide };
}
