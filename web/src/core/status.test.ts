import { describe, expect, it } from "vitest";
import { SIDEBAR_ORDER, STATUS_META, STATUS_ORDER } from "./status";
import { STATUS_ICON } from "./Icon";
import { visibleCells } from "../shell/filter";
import { buildMockState } from "./mock";
import type { PanelStatus } from "./types";

describe("status metadata", () => {
  it("uses the mockup labels", () => {
    expect(STATUS_META.done.label).toBe("Merged");
    expect(STATUS_META.expired.label).toBe("Lease expired");
    expect(STATUS_META.waiting.label).toBe("Waiting");
    expect(STATUS_META.needs_human.label).toBe("Needs human");
  });

  it("sidebar order is merged, running, ready, waiting, expired, needs human, needs split", () => {
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
