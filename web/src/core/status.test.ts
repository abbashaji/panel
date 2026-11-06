import { describe, expect, it } from "vitest";
import { SIDEBAR_ORDER, STATUS_META, STATUS_ORDER, RESUME_LABEL, displayLabel, displayMeta, isResumable } from "./status";
import { STATUS_ICON } from "./Icon";
import { visibleCells } from "../shell/filter";
import { buildMockState } from "./mock";
import type { PanelStatus } from "./types";

describe("status metadata", () => {
  it("uses the mockup labels", () => {
    expect(STATUS_META.done.label).toBe("Merged");
    expect(STATUS_META.expired.label).toBe("Lease expired");
    expect(STATUS_META.waiting.label).toBe("Waiting");
    expect(STATUS_META.needs_human.label).toBe("Needs steward");
  });

  it("sidebar order is merged, running, ready, waiting, expired, needs steward, needs split", () => {
    expect(SIDEBAR_ORDER).toEqual(["done", "running", "ready", "waiting", "expired", "needs_human", "needs_split"]);
    // the urgency order used by the table sort is unchanged
    expect(STATUS_ORDER[0]).toBe("expired");
    expect(STATUS_ORDER.at(-1)).toBe("done");
  });

  it("every status has a color, a label and a drawn icon", () => {
    for (const s of STATUS_ORDER as PanelStatus[]) {
      expect(STATUS_META[s].color).toMatch(/^#[0-9A-F]{6}$/);
      expect(STATUS_META[s].label.length).toBeGreaterThan(0);
      expect(STATUS_ICON[s]).toBeTruthy();
    }
  });
});

describe("visibleCells", () => {
  const cells = buildMockState().cells;
  const base = { search: "", statuses: [] as PanelStatus[], criticalOnly: false, hideMerged: false };

  it("no filter keeps everything", () => {
    expect(visibleCells(cells, base)).toHaveLength(cells.length);
  });

  it("hideMerged drops done cells only", () => {
    const out = visibleCells(cells, { ...base, hideMerged: true });
    expect(out.some((c) => c.status === "done")).toBe(false);
    expect(out).toHaveLength(cells.filter((c) => c.status !== "done").length);
  });

  it("criticalOnly keeps critical cells only", () => {
    const out = visibleCells(cells, { ...base, criticalOnly: true });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.critical)).toBe(true);
  });

  it("filters combine", () => {
    const out = visibleCells(cells, { ...base, statuses: ["waiting"], search: "graph" });
    expect(out.map((c) => c.id)).toEqual(["C-005"]);
  });
});

describe("displayLabel", () => {
  it("shows Ready to resume for a resumable ready or expired cell", () => {
    expect(displayLabel({ status: "ready", resumable: true })).toBe("Ready to resume");
    expect(displayLabel({ status: "expired", resumable: true })).toBe(RESUME_LABEL);
    expect(isResumable({ status: "expired", resumable: true })).toBe(true);
  });

  it("a reset cell (resumable false) and a cell without the flag keep the plain label", () => {
    expect(displayLabel({ status: "ready", resumable: false })).toBe("Ready");
    expect(displayLabel({ status: "ready" })).toBe("Ready");
    expect(displayLabel({ status: "expired", resumable: false })).toBe("Lease expired");
    expect(displayLabel({ status: "expired", resumable: null })).toBe("Lease expired");
  });

  it("ignores the flag on statuses that cannot resume", () => {
    for (const s of ["done", "running", "waiting", "needs_human", "needs_split"] as PanelStatus[]) {
      expect(isResumable({ status: s, resumable: true })).toBe(false);
      expect(displayLabel({ status: s, resumable: true })).toBe(STATUS_META[s].label);
    }
  });

  it("displayMeta gives the resume glyph and the Ready color; plain cells keep their meta", () => {
    const m = displayMeta({ status: "expired", resumable: true });
    expect(m.resume).toBe(true);
    expect(m.label).toBe("Ready to resume");
    expect(m.icon).not.toBe(STATUS_META.ready.icon);
    expect(m.color).toBe(STATUS_META.ready.color);
    expect(displayMeta({ status: "ready", resumable: false })).toEqual({ ...STATUS_META.ready, resume: false });
  });

  it("keeps the status ids and labels unchanged", () => {
    expect(STATUS_META.ready.label).toBe("Ready");
    expect(STATUS_META.expired.label).toBe("Lease expired");
    expect(Object.keys(STATUS_META).sort()).toEqual([...STATUS_ORDER].sort());
  });

  it("status filter chips still work on the status id for resumable cells", () => {
    const flagged = buildMockState().cells.map((c) => ({ ...c, resumable: true }) as typeof c);
    const f = { search: "", statuses: ["ready"] as PanelStatus[], criticalOnly: false, hideMerged: false };
    expect(visibleCells(flagged, f)).toHaveLength(flagged.filter((c) => c.status === "ready").length);
  });
});
