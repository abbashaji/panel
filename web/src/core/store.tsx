import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, getState, login as apiLogin } from "./api";
import { orderedIds, selectionReducer } from "./selection";
import { readStore, writeStore } from "./storage";
import type { PanelState, PanelStatus } from "./types";

export type View = "graph" | "table" | "timeline";
export type Theme = "dark" | "light";
export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

/** Hooks the launch slot (C-010) fills in. Until then every call answers with a toast. */
export interface Launcher {
  start(id: string): void;
  open(id: string): void;
  /** ask the launcher to delete local records of these merged cells */
  sync(mergedIds: string[]): void;
  /** display name of the person who owns the cell (reserved / started it), or null */
  owner(id: string): string | null;
  /** reserve these ready cells and start them through one launcher window (default: no-op) */
  startMany?: (ids: string[]) => void;
  /** start or resume the Steward through the launcher (default: none, the chip hides its Start / Resume buttons) */
  startSteward?: () => void;
}

/** Actions other slots provide for each other (the inspector registers requestRelease for the graph banner). */
export interface PanelActions {
  requestRelease(id: string): void;
}

export interface PanelContextValue {
  repo: string;
  setRepo(repo: string): void;
  /** recently used repos, newest first (max 8, persisted in localStorage bp_repos) */
  recentRepos: string[];
  /** validate owner/name, switch to it and reset selection, search and filters; false when invalid */
  switchRepo(repo: string): boolean;
  forgetRepo(repo: string): void;
  state: PanelState | null;
  loading: boolean;
  error: Error | null;
  /** the API answered 401: show the login screen */
  needsLogin: boolean;
  login(password: string): Promise<void>;
  /** refetch the panel state and resolve when the new data is in */
  refresh(): Promise<void>;
  /** after release / clear-feedback / reserve: patch the cached cell at once, then refetch (0, 1.5, 4, 8 s) until its status matches */
  refreshAfterAction(cellId: string, expected: ExpectedCell): Promise<void>;

  selection: string[];
  setSelection(ids: string[]): void;
  select(id: string, multi?: boolean): void;
  clearSelection(): void;
  moveSelection(dir: 1 | -1): void;

  view: View;
  setView(v: View): void;
  search: string;
  setSearch(q: string): void;
  /** empty = no status filter */
  statusFilter: PanelStatus[];
  toggleStatusFilter(s: PanelStatus): void;
  clearFilters(): void;
  /** sidebar filters: keep only critical cells / drop merged cells */
  criticalOnly: boolean;
  hideMerged: boolean;
  toggleCriticalOnly(): void;
  toggleHideMerged(): void;
  /** ms timestamp of the last successful poll; null before the first load */
  lastUpdated: number | null;

  theme: Theme;
  toggleTheme(): void;

  toasts: ToastItem[];
  toast(msg: string, kind?: ToastKind): void;
  dismissToast(id: number): void;

  launcher: Launcher;
  registerLauncher(part: Partial<Launcher>): () => void;
  actions: PanelActions;
  registerActions(part: Partial<PanelActions>): () => void;
}

const Ctx = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePanel must be used inside <PanelProvider>");
  return v;
}

const REPO_KEY = "bp_repo";
const THEME_KEY = "bp_theme";
const RECENT_KEY = "bp_repos";
const MAX_RECENT = 8;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function withRecent(list: string[], repo: string): string[] {
  return [repo, ...list.filter((r) => r !== repo)].slice(0, MAX_RECENT);
}

function initialRecent(current: string): string[] {
  let list: string[] = [];
  try {
    const raw: unknown = JSON.parse(readStore(RECENT_KEY) ?? "[]");
    if (Array.isArray(raw)) list = raw.filter((r): r is string => typeof r === "string" && REPO_RE.test(r));
  } catch {
    /* ignore a corrupt value */
  }
  list = [...new Set(list)].slice(0, MAX_RECENT);
  return REPO_RE.test(current) ? withRecent(list, current) : list;
}
export const POLL_MS = 5000;

/** What the Worker said the cell looks like after an action. */
export interface ExpectedCell {
  status: PanelStatus;
  resumable?: boolean;
  /** also clear reservedBy (release) */
  clearOwner?: boolean;
}

/** Refetch times after an action, in ms from the action. GitHub can serve the old branch for a few seconds after a write. */
export const ACTION_RETRY_MS: number[] = [0, 1500, 4000, 8000];

interface Pending {
  expected: ExpectedCell;
  matched: boolean;
}

function patchCell(s: PanelState, id: string, e: ExpectedCell): PanelState {
  return {
    ...s,
    cells: s.cells.map((c) => {
      if (c.id !== id) return c;
      const next: Record<string, unknown> = { ...c, status: e.status };
      if (e.resumable !== undefined) next.resumable = e.resumable;
      if (e.clearOwner) next.reservedBy = null;
      return next as unknown as typeof c;
    }),
  };
}

function initialRepo(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("repo");
  return (fromUrl ?? readStore(REPO_KEY) ?? "").trim();
}

function initialTheme(): Theme {
  const saved = readStore(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  // dark is the default (approved mockup); the system setting is ignored
  return "dark";
}

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function PanelProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [repo, setRepoState] = useState(initialRepo);
  const [view, setView] = useState<View>("graph");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<PanelStatus[]>([]);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [hideMerged, setHideMerged] = useState(false);
  const [selection, dispatch] = useReducer(selectionReducer, []);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(1);

  const [recentRepos, setRecentRepos] = useState<string[]>(() => initialRecent(initialRepo()));
  useEffect(() => {
    writeStore(RECENT_KEY, JSON.stringify(recentRepos));
  }, [recentRepos]);

  const switchRepo = useCallback((input: string): boolean => {
    const r = input.trim();
    if (!REPO_RE.test(r)) return false;
    writeStore(REPO_KEY, r);
    setRepoState(r);
    setRecentRepos((l) => withRecent(l, r));
    dispatch({ type: "clear" });
    setSearch("");
    setStatusFilter([]);
    setCriticalOnly(false);
    setHideMerged(false);
    // initialRepo reads ?repo= first, so keep the address in step with the chosen repo
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("repo", r);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      /* ignore */
    }
    return true;
  }, []);
  const forgetRepo = useCallback((r: string) => setRecentRepos((l) => l.filter((x) => x !== r)), []);

  // cells whose status we expect after an action; a refetch that still shows the old status is patched, not shown
  const pendingRef = useRef(new Map<string, Pending>());
  const runsRef = useRef(new Set<() => void>());

  const query = useQuery({
    queryKey: ["panel-state", repo],
    queryFn: async () => {
      const s = await getState(repo);
      let out = s;
      for (const [id, p] of pendingRef.current) {
        const c = s.cells.find((x) => x.id === id);
        if (!c) continue;
        if (c.status === p.expected.status) {
          p.matched = true;
          pendingRef.current.delete(id);
        } else {
          out = patchCell(out, id, p.expected);
        }
      }
      return out;
    },
    enabled: repo !== "",
    retry: false,
    // live updates by polling every 5 s; stop while the login screen is shown
    refetchInterval: (q) => (q.state.error instanceof ApiError && q.state.error.status === 401 ? false : POLL_MS),
  });
  const state = query.data ?? null;
  const needsLogin = query.error instanceof ApiError && query.error.status === 401;

  // a repo change or unmount stops every running retry series and forgets pending expectations
  useEffect(() => {
    const runs = runsRef.current;
    const pending = pendingRef.current;
    pending.clear();
    return () => {
      for (const cancel of [...runs]) cancel();
      runs.clear();
      pending.clear();
    };
  }, [repo]);

  const refreshAfterAction = useCallback(
    (cellId: string, expected: ExpectedCell): Promise<void> => {
      const key = ["panel-state", repo];
      const entry: Pending = { expected, matched: false };
      pendingRef.current.set(cellId, entry);
      // optimistic patch, applied synchronously
      qc.setQueryData<PanelState>(key, (old) => (old ? patchCell(old, cellId, expected) : old));

      let cancelled = false;
      let wake: (() => void) | null = null;
      let timer: number | undefined;
      const cancel = () => {
        cancelled = true;
        if (timer !== undefined) window.clearTimeout(timer);
        wake?.();
      };
      runsRef.current.add(cancel);
      const started = Date.now();
      return (async () => {
        try {
          for (const at of ACTION_RETRY_MS) {
            const wait = at - (Date.now() - started);
            if (wait > 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
                timer = window.setTimeout(resolve, wait);
              });
            }
            if (cancelled || (!entry.matched && pendingRef.current.get(cellId) !== entry)) return;
            try {
              await qc.refetchQueries({ queryKey: key, exact: true });
            } catch {
              /* try again at the next time */
            }
            if (cancelled || entry.matched) return;
          }
        } finally {
          runsRef.current.delete(cancel);
          if (pendingRef.current.get(cellId) === entry) pendingRef.current.delete(cellId);
        }
      })();
    },
    [qc, repo],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writeStore(THEME_KEY, theme);
  }, [theme]);

  // after every poll: forget selected ids that no longer exist
  useEffect(() => {
    if (state) dispatch({ type: "prune", ids: state.cells.map((c) => c.id) });
  }, [state]);

  // Esc clears the selection (unless the user is typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditable(e.target)) dispatch({ type: "clear" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (msg: string, kind: ToastKind = "info") => {
      const id = toastId.current++;
      setToasts((t) => [...t.slice(-3), { id, msg, kind }]);
      window.setTimeout(() => dismissToast(id), kind === "error" ? 8000 : 5000);
    },
    [dismissToast],
  );

  const [launcherPart, setLauncherPart] = useState<Partial<Launcher>>({});
  const [actionsPart, setActionsPart] = useState<Partial<PanelActions>>({});
  const stateRef = useRef(state);
  stateRef.current = state;

  const launcher = useMemo<Launcher>(
    () => ({
      start: launcherPart.start ?? (() => toast("Launcher not installed. Install it with launcher/install.ps1.", "error")),
      open: launcherPart.open ?? (() => toast("Launcher not installed. Install it with launcher/install.ps1.", "error")),
      sync: launcherPart.sync ?? (() => {}),
      startMany: launcherPart.startMany ?? (() => {}),
      owner: launcherPart.owner ?? ((id) => stateRef.current?.cells.find((c) => c.id === id)?.reservedBy ?? null),
    }),
    [launcherPart, toast],
  );
  const actions = useMemo<PanelActions>(
    () => ({
      requestRelease: actionsPart.requestRelease ?? (() => toast("Release is not available yet.", "info")),
    }),
    [actionsPart, toast],
  );

  const registerLauncher = useCallback((part: Partial<Launcher>) => {
    setLauncherPart((p) => ({ ...p, ...part }));
    return () =>
      setLauncherPart((p) => {
        const next = { ...p };
        for (const k of Object.keys(part) as (keyof Launcher)[]) if (next[k] === part[k]) delete next[k];
        return next;
      });
  }, []);
  const registerActions = useCallback((part: Partial<PanelActions>) => {
    setActionsPart((p) => ({ ...p, ...part }));
    return () =>
      setActionsPart((p) => {
        const next = { ...p };
        for (const k of Object.keys(part) as (keyof PanelActions)[]) if (next[k] === part[k]) delete next[k];
        return next;
      });
  }, []);

  const value = useMemo<PanelContextValue>(
    () => ({
      repo,
      setRepo: (r: string) => {
        const v = r.trim();
        writeStore(REPO_KEY, v);
        setRepoState(v);
      },
      recentRepos,
      switchRepo,
      forgetRepo,
      state,
      loading: query.isLoading,
      error: query.error,
      needsLogin,
      login: async (password: string) => {
        await apiLogin(password);
        await qc.invalidateQueries({ queryKey: ["panel-state"] });
      },
      refresh: async () => {
        await query.refetch();
      },
      refreshAfterAction,

      selection,
      setSelection: (ids) => dispatch({ type: "set", ids }),
      select: (id, multi = false) => dispatch({ type: "select", id, multi }),
      clearSelection: () => dispatch({ type: "clear" }),
      moveSelection: (dir) => dispatch({ type: "move", dir, order: orderedIds(state?.cells ?? []) }),

      view,
      setView,
      search,
      setSearch,
      statusFilter,
      toggleStatusFilter: (s) => setStatusFilter((f) => (f.includes(s) ? f.filter((x) => x !== s) : [...f, s])),
      clearFilters: () => {
        setSearch("");
        setStatusFilter([]);
        setCriticalOnly(false);
        setHideMerged(false);
      },
      criticalOnly,
      hideMerged,
      toggleCriticalOnly: () => setCriticalOnly((v) => !v),
      toggleHideMerged: () => setHideMerged((v) => !v),
      lastUpdated: query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null,

      theme,
      toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),

      toasts,
      toast,
      dismissToast,

      launcher,
      registerLauncher,
      actions,
      registerActions,
    }),
    [repo, recentRepos, switchRepo, forgetRepo, state, query, needsLogin, qc, refreshAfterAction, selection, view, search, statusFilter, criticalOnly, hideMerged, theme, toasts, toast, dismissToast, launcher, registerLauncher, actions, registerActions],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
