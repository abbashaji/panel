import type { ComponentType, ReactNode } from "react";
import { LoginScreen } from "./core/LoginScreen";
import { PanelProvider, usePanel, type View } from "./core/store";
import { STATUS_META, STATUS_ORDER } from "./core/status";
import { ToastHost } from "./core/ToastHost";

// Feature slots live in their own folders (graph, inspector, shell, table, launch) and are owned by later cells.
// Each folder's index.tsx is picked up here when it exists; a missing slot renders a labelled placeholder.
//   shell/index.tsx     default = Shell({children})  (header, sidebar, activity strip around children)
//   graph/index.tsx     default = GraphView
//   table/index.tsx     default = TableView, named export TimelineView
//   inspector/index.tsx default = Inspector
//   launch/index.tsx    default = LaunchProvider({children})
// Every slot component takes no props (except the two wrappers) and reads usePanel().
const mods = import.meta.glob("./{graph,inspector,shell,table,launch}/index.tsx", { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

function pick<P = object>(folder: string, exportName = "default"): ComponentType<P> | undefined {
  return mods[`./${folder}/index.tsx`]?.[exportName] as ComponentType<P> | undefined;
}

type Wrapper = ComponentType<{ children?: ReactNode }>;
const Shell = pick<{ children?: ReactNode; aside?: ReactNode }>("shell");
const LaunchProvider = pick<{ children?: ReactNode }>("launch");
const GraphView = pick("graph");
const TableView = pick("table");
const TimelineView = pick("table", "TimelineView");
const Inspector = pick("inspector");

function Placeholder({ name }: { name: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6" style={{ color: "var(--muted)" }}>
      {name} (not built yet)
    </div>
  );
}

const VIEWS: View[] = ["graph", "table", "timeline"];

/** Used until the shell slot exists: a minimal header so the app is usable. */
const FallbackShell: ComponentType<{ children?: ReactNode; aside?: ReactNode }> = ({ children, aside }) => {
  const { state, view, setView, theme, toggleTheme } = usePanel();
  return (
    <div className="flex h-full flex-col">
      <header
        className="flex h-14 shrink-0 items-center gap-4 border-b px-4"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <strong>{state?.project ?? "Blueprint Panel"}</strong>
        {state && (
          <span className="mono text-xs" style={{ color: "var(--muted)" }}>
            {STATUS_ORDER.filter((s) => state.counts[s] > 0)
              .map((s) => `${STATUS_META[s].icon} ${state.counts[s]} ${STATUS_META[s].label}`)
              .join("  ")}
          </span>
        )}
        <span className="flex-1" />
        <div role="tablist" className="flex gap-1">
          {VIEWS.map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className="rounded px-2 py-1 capitalize" style={{ background: view === v ? "var(--surface-2)" : "transparent" }}>
              {v}
            </button>
          ))}
        </div>
        <button type="button" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        {children}
        {aside}
      </div>
    </div>
  );
};

function MainView() {
  const { view } = usePanel();
  const C = view === "graph" ? GraphView : view === "table" ? TableView : TimelineView;
  return C ? <C /> : <Placeholder name={view} />;
}

function Body() {
  const { state, error, loading } = usePanel();
  const S = Shell ?? FallbackShell;
  const aside = (
    <aside
      aria-label="Inspector"
      className="hidden w-[320px] shrink-0 overflow-y-auto border-l p-5 lg:block"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      {Inspector ? <Inspector /> : <Placeholder name="inspector" />}
    </aside>
  );
  return (
    <S aside={aside}>
      <main className="relative min-h-0 min-w-0 flex-1">
        {error && !state ? (
          <div role="alert" className="p-6" style={{ color: "var(--danger)" }}>
            Could not load the state: {error.message}
          </div>
        ) : loading && !state ? (
          <div className="p-6" style={{ color: "var(--muted)" }}>
            Loading…
          </div>
        ) : (
          <MainView />
        )}
      </main>
    </S>
  );
}

function Gate() {
  const { repo, needsLogin } = usePanel();
  if (repo === "" || needsLogin) return <LoginScreen />;
  return <Body />;
}

export default function App() {
  const L: Wrapper = LaunchProvider ?? (({ children }) => <>{children}</>);
  return (
    <PanelProvider>
      <L>
        <Gate />
        <ToastHost />
      </L>
    </PanelProvider>
  );
}
