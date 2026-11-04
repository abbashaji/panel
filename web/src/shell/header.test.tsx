// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelContextValue } from "../core/store";
import type { PanelCell, PanelState } from "../core/types";
import Header from "./Header";
import Settings from "./Settings";

const h = vi.hoisted(() => ({ panel: {} as PanelContextValue }));
vi.mock("../core/store", () => ({ usePanel: () => h.panel }));

const mk = (id: string, status: PanelCell["status"]) =>
  ({ id, title: id, status, lastCommit: null }) as unknown as PanelCell;

const STATE = {
  repo: "o/r",
  project: "Demo",
  mainSha: "abcdef1",
  generatedAt: "2026-11-04T00:00:00Z",
  counts: { done: 1, running: 1, ready: 0, waiting: 2, expired: 0, needs_human: 0, needs_split: 0 },
  cells: [mk("C-001", "done"), mk("C-002", "running"), mk("C-003", "waiting"), mk("C-004", "waiting")],
  bottleneck: null,
} as unknown as PanelState;

const toggleTheme = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  toggleTheme.mockClear();
  h.panel = { state: STATE, lastUpdated: Date.now() - 5000, theme: "dark", toggleTheme } as unknown as PanelContextValue;
});
afterEach(cleanup);

describe("Header", () => {
  it("shows the repo chip, the merged progress and the live age", () => {
    render(<Header onSearch={() => {}} />);
    expect(screen.getByText(/o\/r · main/)).toBeTruthy();
    expect(screen.getByText("1 / 4 merged")).toBeTruthy();
    expect(screen.getByRole("img", { name: /1 of 4 merged, 1 running, 0 lease expired/ })).toBeTruthy();
    expect(screen.getByText(/Live · \d+s/)).toBeTruthy();
  });

  it("says Connecting before the first poll and falls back to You", () => {
    h.panel = { ...h.panel, lastUpdated: null, state: null } as unknown as PanelContextValue;
    render(<Header onSearch={() => {}} />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
  });

  it("user chip uses the saved display name", () => {
    window.localStorage.setItem("bp_who", "Ali Work");
    render(<Header onSearch={() => {}} />);
    expect(screen.getByText("Ali Work")).toBeTruthy();
    expect(screen.getByText("AW")).toBeTruthy();
  });

  it("the search box opens the palette", () => {
    const onSearch = vi.fn();
    render(<Header onSearch={onSearch} />);
    fireEvent.click(screen.getByRole("button", { name: "Search cells" }));
    expect(onSearch).toHaveBeenCalled();
  });
});

describe("Header Run ready button", () => {
  const withReady = (...ids: string[]) =>
    ({ ...STATE, cells: [...STATE.cells, ...ids.map((id) => mk(id, "ready"))] }) as unknown as PanelState;

  it("is hidden when no cell is ready", () => {
    render(<Header onSearch={() => {}} />);
    expect(screen.queryByRole("button", { name: /Run ready/ })).toBeNull();
  });

  it("shows the ready count and opens the dialog with the ready cells only", () => {
    h.panel = { ...h.panel, state: withReady("C-010", "C-011") } as unknown as PanelContextValue;
    render(<Header onSearch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Run ready (2)" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("C-010")).toBeTruthy();
    expect(screen.getByText("C-011")).toBeTruthy();
    expect(screen.queryByText("C-002")).toBeNull();
  });

  it("Run calls launcher.startMany with the ticked ids and closes the dialog", () => {
    const startMany = vi.fn();
    h.panel = { ...h.panel, state: withReady("C-010", "C-011"), launcher: { startMany } } as unknown as PanelContextValue;
    render(<Header onSearch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Run ready (2)" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /C-011/ }));
    fireEvent.click(screen.getByRole("button", { name: "Run 1 cells" }));
    expect(startMany).toHaveBeenCalledWith(["C-010"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Settings", () => {
  it("saves a valid display name to localStorage and rejects an invalid one", () => {
    render(<Settings open onOpenChange={() => {}} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Sara K." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(window.localStorage.getItem("bp_who")).toBe("Sara K.");

    fireEvent.change(input, { target: { value: "bad<name>" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toMatch(/1 to 40/);
    expect(window.localStorage.getItem("bp_who")).toBe("Sara K.");
  });

  it("explains how Start works and toggles the theme", () => {
    render(<Settings open onOpenChange={() => {}} />);
    expect(screen.getByText(/What happens when a teammate clicks Start/)).toBeTruthy();
    expect(screen.getByText("Chrome opens your profile")).toBeTruthy();
    expect(screen.getByText("HONEST LIMITS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Theme: Dark/ }));
    expect(toggleTheme).toHaveBeenCalled();
  });
});
