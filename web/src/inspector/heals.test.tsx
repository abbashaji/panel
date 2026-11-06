import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PanelCell } from "../core/types";
import { CellDetails } from "./CellDetails";

vi.mock("../core/store", () => ({
  usePanel: () => ({ launcher: { owner: () => null, open: () => {}, start: () => {} } }),
}));

function cell(over: Partial<PanelCell> = {}): PanelCell {
  return {
    id: "C-032",
    title: "t",
    type: "normal",
    priority: 0,
    status: "running",
    critical: false,
    wave: 0,
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
  };
}

const html = (c: PanelCell, log?: Parameters<typeof CellDetails>[0]["healLog"]) =>
  renderToStaticMarkup(<CellDetails cell={c} repo="o/r" onAdmin={() => {}} healLog={log} />);

describe("CellDetails heals", () => {
  it("shows nothing when heals is missing or 0", () => {
    expect(html(cell())).not.toContain("Self-healed");
    expect(html(cell({ heals: 0 }))).not.toContain("Self-healed");
  });

  it("shows the count and the last note", () => {
    const log = [
      { cell: "C-032", kind: "sync_main", at: "2026-11-04T10:00:00Z", note: "old note" },
      { cell: "C-032", kind: "note_added", at: "2026-11-04T11:00:00Z", note: "latest note" },
      { cell: "C-099", kind: "sync_main", at: "2026-11-04T12:00:00Z", note: "other cell" },
    ];
    const out = html(cell({ heals: 2 }), log);
    expect(out).toContain("Self-healed 2 times");
    expect(out).toContain("latest note");
    expect(out).not.toContain("old note");
    expect(out).not.toContain("other cell");
    expect(out).not.toContain("Self-heal budget used");
  });

  it("shows the budget text when heals reached 3", () => {
    expect(html(cell({ heals: 3 }))).toContain("Self-heal budget used, the Steward takes over");
  });

  it("does not throw without a healLog", () => {
    expect(() => html(cell({ heals: 1 }), undefined)).not.toThrow();
  });
});
