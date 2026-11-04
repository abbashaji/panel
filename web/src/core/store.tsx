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
  refresh(): void;

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

  const query = useQuery({
    queryKey: ["panel-state", repo],
    queryFn: () => getState(repo),
    enabled: repo !== "",
    retry: false,
    // live updates by polling every 5 s; stop while the login screen is shown
    refetchInterval: (q) => (q.state.error instanceof ApiError && q.state.error.status === 401 ? false : POLL_MS),
  });
  const state = query.data ?? null;
  const needsLogin = query.error instanceof ApiError && query.error.status === 401;

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
      refresh: () => void query.refetch(),

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
    [repo, recentRepos, switchRepo, forgetRepo, state, query, needsLogin, qc, selection, view, search, statusFilter, criticalOnly, hideMerged, theme, toasts, toast, dismissToast, launcher, registerLauncher, actions, registerActions],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
