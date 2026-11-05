// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanel } from "../core/store";
import type { PanelCell } from "../core/types";
import { CellDetails } from "./CellDetails";

vi.mock("../core/store", () => ({ usePanel: vi.fn() }));

function cell(over: Record<string, unknown>): PanelCell {
  return {
    id: "C-032",
    title: "Resume test cell",
    type: "normal",
    priority: 0,
    status: "ready",
    critical: false,
    wave: 1,
    depends: [],
    blockedBy: [],
    directDependents: 0,
    transitiveDependents: 0,
    sha: { lock: null, tip: null, merged: null },
    lease: null,
    attempts: 0,
    maxAttempts: 3,
    lastCommit: null,
    reservedBy: null,
    pr: null,
    allowedPaths: [],
    provides: [],
    inputs: [],
    ...over,
  } as PanelCell;
}

describe("CellDetails: Ready to resume", () => {
  const launcher = { start: vi.fn(), open: vi.fn(), owner: vi.fn<(id: string) => string | null>(() => null) };

  beforeEach(() => {
    launcher.start.mockReset();
    launcher.open.mockReset();
    launcher.owner.mockReset();
    launcher.owner.mockReturnValue(null);
    vi.mocked(usePanel).mockReturnValue({ launcher } as never);
  });
  afterEach(cleanup);

  const show = (c: PanelCell) => render(<CellDetails cell={c} repo="abbashaji/panel" onAdmin={() => {}} />);

  it("a resumable ready cell shows the label, the handoff line and a Resume button that starts it", () => {
    show(cell({ status: "ready", resumable: true }));
    expect(screen.getByText("Ready to resume")).toBeTruthy();
    expect(screen.getByText("Ready to resume, the last chat left a handoff")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(launcher.start).toHaveBeenCalledWith("C-032");
  });

  it("a resumable expired cell shows Resume instead of Lease expired and Open chat", () => {
    show(cell({ status: "expired", resumable: true }));
    expect(screen.getByText("Ready to resume")).toBeTruthy();
    expect(screen.queryByText("Lease expired")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(launcher.start).toHaveBeenCalledWith("C-032");
  });

  it("a reset cell shows plain Ready, a Start button and no holder", () => {
    launcher.owner.mockReturnValue("Ann"); // this browser still remembers an old start
    show(cell({ status: "ready", resumable: false, reservedBy: null }));
    expect(screen.queryByText("Ready to resume")).toBeNull();
    expect(screen.queryByTestId("resume-note")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByText("Ann")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(launcher.start).toHaveBeenCalledWith("C-032");
  });

  it("a plain expired cell keeps Open chat and has no Resume button", () => {
    show(cell({ status: "expired", resumable: false, reservedBy: "Bob" }));
    expect(screen.queryByText("Ready to resume")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(launcher.open).toHaveBeenCalledWith("C-032");
  });
});
