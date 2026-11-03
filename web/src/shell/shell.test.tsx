// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelContextValue } from "../core/store";
import type { PanelCell, PanelState } from "../core/types";
import TableView, { TimelineView } from "../table";
import { sortCells } from "../table/sort";
import { filterCells } from "./filter";
import Shell from "./index";
import Sidebar from "./Sidebar";

const h = vi.hoisted(() => ({ panel: {} as PanelContextValue }));
vi.mock("../core/store", () => ({ usePanel: () => h.panel }));

const fns = {
  select: vi.fn(),
  toggleStatusFilter: vi.fn(),
  setSearch: vi.fn(),
  clearFilters: vi.fn(),
  setView: vi.fn(),
  toggleTheme: vi.fn(),
  refresh: vi.fn(),
};

function cell(id: string, title: string, status: PanelCell["status"], wave: number, attempts: number, over: Partial<PanelCell> = {}): PanelCell {
  return {
    id,
    title,
    type: "normal",
    priority: 0,
    status,
    critical: false,
    wave,
    depends: [],
    blockedBy: [],
    directDependents: 0,
    transitiveDependents: 0,
    sha: { lock: null, tip: null, merged: null },
    lease: null,
    attempts,
    maxAttempts: 3,
    lastCommit: null,
    reservedBy: null,
    pr: null,
    allowedPaths: [],
    provides: [],
    inputs: [],
    ...over,
  };
}

const CELLS: PanelCell[] = [
  cell("C-001", "Parser core", "done", 0, 1),
  cell("C-002", "Parser errors", "ready", 1, 0),
  cell("C-003", "Graph layout", "running", 1, 2, { lease: { minutesLeft: 30, expiredMinutesAgo: null, ci: false } }),
  cell("C-004", "Table polish", "waiting", 2, 0, { blockedBy: ["C-002"] }),
];

const STATE: PanelState = {
  repo: "o/r",
  project: "Demo",
  mainSha: "abcdef1234",
  generatedAt: "2026-11-04T00:00:00Z",
  counts: { done: 1, running: 1, ready: 1, waiting: 1, expired: 0, needs_human: 0, needs_split: 0 },
  cells: CELLS,
  bottleneck: { id: "C-002", blocks: 1 },
};

function makePanel(over: Partial<PanelContextValue> = {}): PanelContextValue {
  return {
    repo: "o/r",
    state: STATE,
    search: "",
    statusFilter: [],
    selection: [],
    view: "table",
    theme: "dark",
    ...fns,
    ...over,
  } as unknown as PanelContextValue;
}

const ids = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => (r as HTMLTableRowElement).cells[0]?.textContent);

beforeEach(() => {
  Object.values(fns).forEach((f) => f.mockClear());
  h.panel = makePanel();
});
afterEach(cleanup);

describe("filters", () => {
  it("filterCells applies status set and search together", () => {
    expect(filterCells(CELLS, "", []).length).toBe(4);
    expect(filterCells(CELLS, "parser", []).map((c) => c.id)).toEqual(["C-001", "C-002"]);
    expect(filterCells(CELLS, "parser", ["ready"]).map((c) => c.id)).toEqual(["C-002"]);
    expect(filterCells(CELLS, "c-003", []).map((c) => c.id)).toEqual(["C-003"]);
  });

  it("sidebar shows status counts and toggles a filter", () => {
    h.panel = makePanel({ statusFilter: ["ready"] });
    render(<Sidebar />);
    const ready = screen.getByRole("button", { name: /^Ready/ });
    expect(ready.textContent).toMatch(/Ready\s*1$/);
    expect(ready.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Expired/ }).textContent).toMatch(/Expired\s*0$/);
    fireEvent.click(screen.getByRole("button", { name: /^Running/ }));
    expect(fns.toggleStatusFilter).toHaveBeenCalledWith("running");
    fireEvent.click(screen.getByRole("button", { name: /Bottleneck/ }));
    expect(fns.select).toHaveBeenCalledWith("C-002");
  });
});

describe("search palette", () => {
  it("Ctrl+K opens it and Enter selects the matching cell", () => {
    render(
      <Shell>
        <div />
      </Shell>,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "errors" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fns.select).toHaveBeenCalledWith("C-002");
  });
});

describe("table", () => {
  it("sorts by a column and flips direction", () => {
    render(<TableView />);
    expect(ids()).toEqual(["C-001", "C-002", "C-003", "C-004"]);
    fireEvent.click(screen.getByRole("button", { name: /Attempts/ }));
    expect(ids()).toEqual(["C-002", "C-004", "C-001", "C-003"]);
    fireEvent.click(screen.getByRole("button", { name: /Attempts/ }));
    expect(ids()).toEqual(["C-003", "C-001", "C-002", "C-004"]);
  });

  it("sortCells orders by status urgency", () => {
    expect(sortCells(CELLS, "status", "asc").map((c) => c.id)).toEqual(["C-002", "C-003", "C-004", "C-001"]);
  });

  it("honours the shared status filter and search", () => {
    h.panel = makePanel({ statusFilter: ["ready"] });
    const first = render(<TableView />);
    expect(ids()).toEqual(["C-002"]);
    first.unmount();
    h.panel = makePanel({ search: "graph" });
    render(<TableView />);
    expect(ids()).toEqual(["C-003"]);
  });

  it("clicking a row selects it", () => {
    render(<TableView />);
    const row = screen.getAllByRole("row")[2];
    if (!row) throw new Error("row missing");
    fireEvent.click(row);
    expect(fns.select).toHaveBeenCalledWith("C-002", false);
  });
});

describe("timeline", () => {
  it("groups cells by wave", () => {
    render(<TimelineView />);
    const wave1 = screen.getByRole("region", { name: "Wave 1" });
    expect(wave1.textContent).toContain("C-002");
    expect(wave1.textContent).toContain("C-003");
    expect(wave1.textContent).not.toContain("C-004");
  });
});
