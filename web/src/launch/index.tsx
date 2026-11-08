import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ApiError, reserve, stewardCode } from "../core/api";
import { readStore, writeStore } from "../core/storage";
import { usePanel } from "../core/store";
import type { PanelState, ReserveResult } from "../core/types";
import OwnerKeyDialog, { forgetOwnerKey, readOwnerKey, saveOwnerKey } from "./OwnerKeyDialog";
import { CELL_RE, MAX_CELLS, WHO_RE, openUrl, startManyUrl, startUrl, stewardUrl, syncUrl, transport } from "./protocol";

const WHO_KEY = "bp_who";
const OWN_KEY = "bp_own";
const SYNC_THROTTLE_MS = 3000;
/** no sync link this soon after a start/open/steward link: Chrome shows one external-app prompt at a time */
const GO_QUIET_MS = 5000;
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

const sigKey = (repo: string): string => `bp_sync_sig_${repo}`;

/** signature (sorted merged ids) of the last sync link sent for this repo */
function readSig(repo: string): string | null {
  try {
    return readStore(sigKey(repo));
  } catch {
    return null;
  }
}

function writeSig(repo: string, sig: string): void {
  try {
    writeStore(sigKey(repo), sig);
  } catch {
    // the next change sends again
  }
}

type Refresher = { refreshAfterAction?: () => unknown; refresh?: () => unknown };

/** Re-reads the panel state after a write. Uses refreshAfterAction, else refresh; does nothing when the panel has neither. */
function makeRefresh(panel: object): () => void {
  return () => {
    const p = panel as unknown as Refresher;
    const fn = p.refreshAfterAction ?? p.refresh;
    if (typeof fn !== "function") return;
    try {
      void Promise.resolve(fn.call(p)).catch(() => {});
    } catch {
      // the panel keeps its last state
    }
  };
}

type Dlg =
  | { phase: "name"; id?: string; many?: string[]; steward?: boolean }
  | { phase: "confirm"; id: string; url: string; who: string }
  | { phase: "key"; who: string; wrong: boolean; asked: boolean } // no key in here: the dialog keeps the typed key itself
  | null;

/** Registers the launcher hooks with usePanel().registerLauncher and renders the start dialog. */
export default function LaunchProvider({ children }: { children?: ReactNode }) {
  const panel = usePanel();
  const { repo, state, toast, registerLauncher } = panel;
  const refresh = makeRefresh(panel);
  const live = useRef({ repo, state, toast, refresh });
  live.current = { repo, state, toast, refresh };
  const syncMark = useRef({ at: 0 });
  const lastGoAt = useRef(0);
  const syncTimer = useRef<number | null>(null);
  const busy = useRef(false);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState("");

  /**
   * silent blueprint://sync. Sends only when the sorted set of merged ids differs from the last one sent for this repo,
   * at most every SYNC_THROTTLE_MS and never within GO_QUIET_MS after a go; a sync that is too early is delayed.
   */
  const sendSync = useCallback(function run(ids: string[]) {
    const valid = [...new Set(ids)].filter((i) => CELL_RE.test(i)).sort();
    if (valid.length === 0) return;
    if (syncTimer.current !== null) {
      window.clearTimeout(syncTimer.current); // the newest call replaces a delayed one
      syncTimer.current = null;
    }
    const r = live.current.repo;
    const sig = valid.join(",");
    if (readSig(r) === sig) return;
    const now = Date.now();
    const wait = Math.max(syncMark.current.at + SYNC_THROTTLE_MS, lastGoAt.current + GO_QUIET_MS) - now;
    if (wait > 0) {
      syncTimer.current = window.setTimeout(() => {
        syncTimer.current = null;
        run(ids);
      }, wait);
      return;
    }
    let url: string;
    try {
      url = syncUrl(r, valid);
    } catch {
      return;
    }
    syncMark.current.at = now;
    writeSig(r, sig);
    transport.silent(url);
  }, []);

  /** the only place that opens a launcher link: remembers when, so no sync link follows closely */
  const fire = useCallback((url: string) => {
    lastGoAt.current = Date.now();
    transport.go(url);
    transport.watch(() => live.current.toast(HINT, "info"));
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
      const { repo: r, toast: say, refresh: again } = live.current;
      try {
        let res: ReserveResult;
        try {
          res = await reserve(r, id, who);
        } catch (e) {
          say(`Could not reserve ${id}: ${errText(e)}`, "error");
          return;
        }
        again(); // reserved: show the reservation chip at once; taken or not_ready: the panel was wrong, so show the real state
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

  /** reserve the cells one after another, drop the ones that fail, then fire one startmany link */
  const doStartMany = useCallback(
    async (ids: string[], who: string) => {
      if (busy.current) return;
      busy.current = true;
      const { repo: r, toast: say, refresh: again } = live.current;
      try {
        try {
          startManyUrl(r, who, ids); // fail before reserving anything when the link cannot be built
        } catch (e) {
          say(`Cannot build the launcher link: ${errText(e)}`, "error");
          return;
        }
        const ok: string[] = [];
        const dropped: string[] = [];
        for (const id of ids) {
          try {
            const res = await reserve(r, id, who);
            if (res.status === "reserved") ok.push(id);
            else dropped.push(`${id} (${res.status === "taken" ? "taken" : "not ready"})`);
          } catch {
            dropped.push(`${id} (error)`);
          }
        }
        again(); // one refresh after the whole batch, also when every reserve failed
        if (dropped.length > 0) say(`Not started: ${dropped.join(", ")}`, "error");
        if (ok.length === 0) return;
        let url: string;
        try {
          url = startManyUrl(r, who, ok);
        } catch (e) {
          say(`Cannot build the launcher link: ${errText(e)}`, "error");
          return;
        }
        for (const id of ok) rememberOwn(r, id);
        fire(url);
      } finally {
        busy.current = false;
      }
    },
    [sendSync],
  );

  const startMany = useCallback(
    (ids: string[]) => {
      const want = [...new Set(ids)].filter((id) => CELL_RE.test(id));
      if (want.length === 0) {
        live.current.toast("No valid cells to start.", "error");
        return;
      }
      if (want.length > MAX_CELLS) {
        live.current.toast(`Run at most ${MAX_CELLS} cells at once.`, "error");
        return;
      }
      const who = readWho();
      if (!who) {
        setName("");
        setNameErr("");
        setDlg({ phase: "name", many: want });
        return;
      }
      void doStartMany(want, who);
    },
    [doStartMany],
  );

  const open = useCallback(
    (id: string) => {
      const { repo: r, state: s, toast: say, refresh: again } = live.current;
      if (s?.cells.find((c) => c.id === id)?.status === "done") {
        say(`${id} is merged; there is no chat to open.`, "info");
        return;
      }
      let url: string;
      try {
        url = openUrl(r, id);
      } catch (e) {
        say(`Cannot build the launcher link: ${errText(e)}`, "error");
        return;
      }
      again();
      fire(url);
    },
    [fire],
  );

  /**
   * Trade the admin key for a short-lived code and open blueprint://steward with it; no reservation, the Worker lease decides
   * who wins (a second chat gets STEWARD_BUSY). The key goes to the Worker only: never into a link, toast, log or state.
   * reasked: the key was already asked for again after a 403. remember: set only when the key was just typed.
   */
  const runSteward = useCallback(
    async (who: string, key: string, reasked: boolean, remember?: boolean) => {
      if (busy.current) return;
      busy.current = true;
      const { repo: r, toast: say, refresh: again } = live.current;
      try {
        let code: string;
        try {
          code = (await stewardCode(r, key)).code;
        } catch (e) {
          if (e instanceof ApiError && e.status === 403) {
            forgetOwnerKey();
            if (reasked) say("The admin key was not accepted.", "error");
            else setDlg({ phase: "key", who, wrong: true, asked: true });
            return;
          }
          say(e instanceof ApiError ? `Could not start the steward (HTTP ${e.status}).` : "Could not start the steward.", "error");
          return;
        }
        if (remember !== undefined) saveOwnerKey(key, remember);
        let url: string;
        try {
          url = stewardUrl(r, who, code);
        } catch (e) {
          say(`Cannot build the launcher link: ${errText(e)}`, "error");
          return;
        }
        fire(url);
        again();
      } finally {
        busy.current = false;
      }
    },
    [fire],
  );

  const doSteward = useCallback(
    (who: string) => {
      const key = readOwnerKey();
      if (key === null) {
        setDlg({ phase: "key", who, wrong: false, asked: false });
        return;
      }
      void runSteward(who, key, false);
    },
    [runSteward],
  );

  const startSteward = useCallback(() => {
    const who = readWho();
    if (!who) {
      setName("");
      setNameErr("");
      setDlg({ phase: "name", steward: true });
      return;
    }
    doSteward(who);
  }, [doSteward]);

  /** my name for my own cells; for others' cells their name */
  const owner = useCallback((id: string): string | null => {
    if (isMine(id)) return readWho() || null;
    return live.current.state?.cells.find((c) => c.id === id)?.reservedBy ?? null;
  }, [isMine]);

  useEffect(
    () => registerLauncher({ start, startMany, startSteward, open, owner, sync: (ids: string[]) => sendSync(ids) }),
    [registerLauncher, start, startMany, startSteward, open, owner, sendSync],
  );

  // when the state changes: tell the launcher which cells are merged, and forget merged cells as mine
  useEffect(() => {
    if (!state) return;
    const merged = mergedIds(state);
    sendSync(merged);
    const own = readOwn(repo);
    const keep = own.filter((id) => !merged.includes(id));
    if (keep.length !== own.length) writeOwn(repo, keep);
  }, [state, repo, sendSync]);

  // a delayed sync must not fire after the provider is gone
  useEffect(
    () => () => {
      if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
    },
    [],
  );

  const submitName = (e: FormEvent) => {
    e.preventDefault();
    if (dlg?.phase !== "name") return;
    const v = name.trim();
    if (!WHO_RE.test(v)) {
      setNameErr("Use 1 to 40 letters, digits, spaces, dots, dashes or underscores.");
      return;
    }
    writeStore(WHO_KEY, v);
    const { id, many, steward } = dlg;
    setDlg(null);
    if (steward) doSteward(v);
    else if (many) void doStartMany(many, v);
    else if (id) void doStart(id, v);
  };

  const submitKey = (key: string, remember: boolean) => {
    if (dlg?.phase !== "key") return;
    const { who, asked } = dlg;
    setDlg(null);
    void runSteward(who, key, asked, remember);
  };

  const confirm = () => {
    if (dlg?.phase !== "confirm") return;
    const { url } = dlg;
    setDlg(null);
    fire(url);
  };

  const box =
    "fixed left-1/2 top-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[color:var(--border,#8884)] " +
    "bg-[color:var(--surface,#fff)] p-5 text-[color:var(--text,#111)] shadow-xl";
  const btn = "rounded-md border border-[color:var(--border,#8884)] px-3 py-1.5 text-sm";
  const primary = "rounded-md bg-[#5B9DFF] px-3 py-1.5 text-sm font-medium text-[#0b1020]";

  return (
    <>
      {children}
      <OwnerKeyDialog
        open={dlg?.phase === "key"}
        wrong={dlg?.phase === "key" && dlg.wrong}
        onSubmit={submitKey}
        onCancel={() => setDlg(null)}
      />
      <Dialog.Root open={dlg !== null && dlg.phase !== "key"} onOpenChange={(o) => !o && setDlg(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          {dlg?.phase === "name" && (
            <Dialog.Content className={box}>
              <Dialog.Title className="text-base font-semibold">Who are you?</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm">
                Your display name is shown next to the cells you start. It is kept in this browser only.
              </Dialog.Description>
              <form onSubmit={submitName} className="mt-4 flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  Display name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={40}
                    autoFocus
                    className="rounded-md border border-[color:var(--border,#8884)] bg-transparent px-2 py-1.5"
                  />
                </label>
                {nameErr && (
                  <p role="alert" className="text-sm text-[#FF6B5E]">
                    {nameErr}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Dialog.Close className={btn}>Cancel</Dialog.Close>
                  <button type="submit" className={primary}>
                    Continue
                  </button>
                </div>
              </form>
            </Dialog.Content>
          )}
          {dlg?.phase === "confirm" && (
            <Dialog.Content className={box}>
              <Dialog.Title className="text-base font-semibold">Start {dlg.id}</Dialog.Title>
              <Dialog.Description className="mt-2 text-sm">
                {dlg.id} is reserved for {dlg.who}. Next, your browser opens claude.ai with a pre-filled prompt. You must press
                Send yourself; nothing is sent for you. The launcher shows its own confirm window first, where you choose the
                browser profile.
              </Dialog.Description>
              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close className={btn}>Cancel</Dialog.Close>
                <button type="button" onClick={confirm} className={primary}>
                  Open claude.ai
                </button>
              </div>
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
