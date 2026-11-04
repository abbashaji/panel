// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelContextValue } from "../core/store";
import type { PanelState } from "../core/types";
import Shell from "./index";
import { PANELS_KEY, usePanelVisibility } from "./usePanelVisibility";

const h = vi.hoisted(() => ({ panel: {} as PanelContextValue }));
vi.mock("../core/store", () => ({ usePanel: () => h.panel }));

const STATE: PanelState = {
  repo: "o/r",
  project: "Demo",
  mainSha: "abcdef1234",
  generatedAt: "2026-11-04T00:00:00Z",
  counts: { done: 0, running: 0, ready: 0, waiting: 0, expired: 0, needs_human: 0, needs_split: 0 },
  cells: [],
  bottleneck: null,
} as unknown as PanelState;

const noop = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  h.panel = {
    repo: "o/r",
    state: STATE,
    search: "",
    statusFilter: [],
    selection: [],
    view: "table",
    theme: "dark",
    criticalOnly: false,
    hideMerged: false,
    lastUpdated: null,
    select: noop,
    toggleStatusFilter: noop,
    setSearch: noop,
    clearFilters: noop,
    setView: noop,
    toggleTheme: noop,
    refresh: noop,
    toggleCriticalOnly: noop,
    toggleHideMerged: noop,
  } as unknown as PanelContextValue;
});
afterEach(cleanup);

const saved = () => JSON.parse(window.localStorage.getItem(PANELS_KEY) ?? "null");
const key = (init: KeyboardEventInit, target: EventTarget = window) => fireEvent.keyDown(target, init);

function renderShell() {
  return render(
    <Shell aside={<div>Inspector body</div>}>
      <div />
    </Shell>,
  );
}

describe("usePanelVisibility", () => {
  it("defaults to all visible and persists changes", () => {
    const { result, unmount } = renderHook(() => usePanelVisibility());
    expect(result.current.visible).toEqual({ sidebar: true, inspector: true, activity: true });
    act(() => result.current.toggle("inspector"));
    expect(result.current.visible.inspector).toBe(false);
    expect(saved()).toEqual({ sidebar: true, inspector: false, activity: true });
    unmount();
    const again = renderHook(() => usePanelVisibility());
    expect(again.result.current.visible.inspector).toBe(false);
  });

  it("show and hide set an explicit value", () => {
    const { result } = renderHook(() => usePanelVisibility());
    act(() => result.current.hide("sidebar"));
    act(() => result.current.hide("sidebar"));
    expect(result.current.visible.sidebar).toBe(false);
    act(() => result.current.show("sidebar"));
    expect(result.current.visible.sidebar).toBe(true);
  });

  it("falls back to defaults for corrupt or partial stored values", () => {
    window.localStorage.setItem(PANELS_KEY, "{not json");
    expect(renderHook(() => usePanelVisibility()).result.current.visible.sidebar).toBe(true);
    window.localStorage.setItem(PANELS_KEY, JSON.stringify({ sidebar: false, activity: "no" }));
    expect(renderHook(() => usePanelVisibility()).result.current.visible).toEqual({ sidebar: false, inspector: true, activity: true });
  });
});

describe("shell panels", () => {
  it("sidebar: hide leaves a rail with only the show button, show restores it", () => {
    renderShell();
    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(hide.getAttribute("aria-controls")).toBe("panel-sidebar");
    expect(hide.getAttribute("title")).toContain("Ctrl+B");
    fireEvent.click(hide);
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
    const rail = screen.getByTestId("rail-sidebar");
    const buttons = within(rail).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Show sidebar");
    expect(buttons[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(saved().sidebar).toBe(false);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(screen.getByRole("navigation", { name: "Sidebar" })).toBeTruthy();
    expect(screen.queryByTestId("rail-sidebar")).toBeNull();
  });

  it("inspector: content is not rendered while hidden", () => {
    renderShell();
    expect(screen.getByText("Inspector body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(screen.queryByText("Inspector body")).toBeNull();
    const rail = screen.getByTestId("rail-inspector");
    expect(within(rail).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(screen.getByText("Inspector body")).toBeTruthy();
  });

  it("activity: collapses to a LIVE ACTIVITY (n) bar and restores", () => {
    renderShell();
    const hide = screen.getByRole("button", { name: "Hide activity" });
    expect(hide.getAttribute("aria-controls")).toBe("panel-activity");
    fireEvent.click(hide);
    expect(screen.getByText(/^LIVE ACTIVITY \(\d+\)$/)).toBeTruthy();
    const show = screen.getByRole("button", { name: "Show activity" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect(screen.getByRole("button", { name: "Hide activity" })).toBeTruthy();
    expect(screen.queryByText(/^LIVE ACTIVITY \(\d+\)$/)).toBeNull();
  });

  it("keyboard shortcuts toggle the three panels", () => {
    renderShell();
    key({ key: "b", ctrlKey: true });
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
    key({ key: "b", ctrlKey: true });
    expect(screen.getByRole("navigation", { name: "Sidebar" })).toBeTruthy();
    key({ key: "i", ctrlKey: true, altKey: true });
    expect(screen.queryByText("Inspector body")).toBeNull();
    key({ key: "j", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Show activity" })).toBeTruthy();
  });

  it("shortcuts are ignored while typing in an input", () => {
    renderShell();
    const input = document.createElement("input");
    document.body.appendChild(input);
    key({ key: "b", ctrlKey: true, bubbles: true }, input);
    expect(screen.getByRole("navigation", { name: "Sidebar" })).toBeTruthy();
    input.remove();
  });
});
