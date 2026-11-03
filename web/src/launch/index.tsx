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

/** Registers the launcher hooks with usePanel().registerLauncher and renders the start dialog. */
export default function LaunchProvider({ children }: { children?: ReactNode }) {
  const { repo, state, toast, registerLauncher } = usePanel();
  const live = useRef({ repo, state, toast });
  live.current = { repo, state, toast };
  const syncMark = useRef({ at: 0, key: "" });
  const busy = useRef(false);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState("");

  /** silent blueprint://sync, throttled; sends only valid merged ids */
  const sendSync = useCallback((ids: string[], force: boolean) => {
    const valid = [...new Set(ids)].filter((i) => CELL_RE.test(i)).sort();
    if (valid.length === 0) return;
    const r = live.current.repo;
    const key = `${r} ${valid.join(",")}`;
    const now = Date.now();
    const m = syncMark.current;
    if (now - m.at < SYNC_THROTTLE_MS || (!force && key === m.key)) return;
    let url: string;
    try {
      url = syncUrl(r, valid);
    } catch {
      return;
    }
    m.at = now;
    m.key = key;
    transport.silent(url);
  }, []);

  const isMine = useCallback((id: string): boolean => {
    const { repo: r, state: s } = live.current;
    const w = readWho();
    return readOwn(r).includes(id) || (w !== "" && s?.cells.find((c) => c.id === id)?.reservedBy === w);
  }, []);

  const doStart = useCallback(
    async (id: string, who: string) => {
      if (busy.current) return;
      busy.current = true;
      const { repo: r, toast: say } = live.current;
      try {
        let res: ReserveResult;
        try {
          res = await reserve(r, id, who);
        } catch (e) {
          say(`Could not reserve ${id}: ${errText(e)}`, "error");
          return;
        }
        if (res.status !== "reserved") {
          const fallback = res.status === "taken" ? `${id} is already taken.` : `${id} is not ready.`;
          say(res.detail || fallback, res.status === "taken" ? "error" : "info");
          return;
        }
        let url: string;
        try {
          url = startUrl(r, id, who);
        } catch (e) {
          say(`Cannot build the launcher link: ${errText(e)}`, "error");
          return;
        }
        rememberOwn(r, id);
        sendSync(mergedIds(live.current.state), true);
        setDlg({ phase: "confirm", id, url, who });
      } finally {
        busy.current = false;
      }
    },
    [sendSync],
  );

  const start = useCallback(
    (id: string) => {
      if (!CELL_RE.test(id)) {
        live.current.toast("Not a valid cell id.", "error");
        return;
      }
      const who = readWho();
      if (!who) {
        setName("");
        setNameErr("");
        setDlg({ phase: "name", id });
        return;
      }
      void doStart(id, who);
    },
    [doStart],
  );

  const open = useCallback(
    (id: string) => {
      const { repo: r, state: s, toast: say } = live.current;
      if (s?.cells.find((c) => c.id === id)?.status === "done") {
        say(`${id} is merged; there is no chat to open.`, "info");
        return;
      }
      if (!isMine(id)) {
        say("Only the person who started a cell can reopen its chat.", "info");
        return;
      }
      let url: string;
      try {
        url = openUrl(r, id);
      } catch (e) {
        say(`Cannot build the launcher link: ${errText(e)}`, "error");
        return;
      }
      sendSync(mergedIds(s), true);
      transport.go(url);
      transport.watch(() => live.current.toast(HINT, "info"));
    },
    [isMine, sendSync],
  );

  /** my name for my own cells; for others' cells their name, with no link */
  const owner = useCallback((id: string): string | null => {
    if (isMine(id)) return readWho() || null;
    return live.current.state?.cells.find((c) => c.id === id)?.reservedBy ?? null;
  }, [isMine]);

  useEffect(
    () => registerLauncher({ start, open, owner, sync: (ids: string[]) => sendSync(ids, true) }),
    [registerLauncher, start, open, owner, sendSync],
  );

  // when the state changes: tell the launcher which cells are merged, and forget merged cells as mine
  useEffect(() => {
    if (!state) return;
    const merged = mergedIds(state);
    sendSync(merged, false);
    const own = readOwn(repo);
    const keep = own.filter((id) => !merged.includes(id));
    if (keep.length !== own.length) writeOwn(repo, keep);
  }, [state, repo, sendSync]);

  const submitName = (e: FormEvent) => {
    e.preventDefault();
    if (dlg?.phase !== "name") return;
    const v = name.trim();
    if (!WHO_RE.test(v)) {
      setNameErr("Use 1 to 40 letters, digits, spaces, dots, dashes or underscores.");
      return;
    }
    writeStore(WHO_KEY, v);
    const id = dlg.id;
    setDlg(null);
    void doStart(id, v);
  };

  const confirm = () => {
    if (dlg?.phase !== "confirm") return;
    const { url } = dlg;
    setDlg(null);
    transport.go(url);
    transport.watch(() => live.current.toast(HINT, "info"));
  };
