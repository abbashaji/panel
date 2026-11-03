import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { reserve } from "../core/api";
import { readStore, writeStore } from "../core/storage";
import { usePanel } from "../core/store";
import type { PanelState, ReserveResult } from "../core/types";
import { CELL_RE, WHO_RE, openUrl, startUrl, syncUrl, transport } from "./protocol";

const WHO_KEY = "bp_who";
const OWN_KEY = "bp_own";
const SYNC_THROTTLE_MS = 3000;
const HINT = "Nothing opened? Install the launcher first: run launcher/install.ps1, then try again.";

/** Display name kept in localStorage; empty when none is saved. */
export function readWho(): string {
  const v = (readStore(WHO_KEY) ?? "").trim();
  return WHO_RE.test(v) ? v : "";
}

function readOwnAll(): Record<string, string[]> {
  try {
    const j: unknown = JSON.parse(readStore(OWN_KEY) ?? "{}");
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out: Record<string, string[]> = {};
    for (const [repo, ids] of Object.entries(j)) {
      if (Array.isArray(ids)) out[repo] = ids.filter((x): x is string => typeof x === "string" && CELL_RE.test(x));
    }
    return out;
  } catch {
    return {};
  }
}

/** Cells this browser reserved or started, per repo. */
export function readOwn(repo: string): string[] {
  return readOwnAll()[repo] ?? [];
}

function writeOwn(repo: string, ids: string[]): void {
  const all = readOwnAll();
  if (ids.length > 0) all[repo] = ids;
  else delete all[repo];
  writeStore(OWN_KEY, JSON.stringify(all));
}

function rememberOwn(repo: string, id: string): void {
  const cur = readOwn(repo);
  if (!cur.includes(id)) writeOwn(repo, [...cur, id]);
}

const mergedIds = (s: PanelState | null): string[] => (s ? s.cells.filter((c) => c.status === "done").map((c) => c.id) : []);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Dlg = { phase: "name"; id: string } | { phase: "confirm"; id: string; url: string; who: string } | null;
