import { describe, expect, it } from "vitest";
import { orderedIds, selectionReducer } from "./selection";
import type { PanelCell } from "./types";

describe("selectionReducer", () => {
  it("click selects one, shift-click toggles", () => {
    let s = selectionReducer([], { type: "select", id: "C-001" });
    expect(s).toEqual(["C-001"]);
    s = selectionReducer(s, { type: "select", id: "C-002", multi: true });
    expect(s).toEqual(["C-001", "C-002"]);
    s = selectionReducer(s, { type: "select", id: "C-001", multi: true });
    expect(s).toEqual(["C-002"]);
    s = selectionReducer(s, { type: "select", id: "C-005" });
    expect(s).toEqual(["C-005"]);
  });

  it("clear (Esc) empties and keeps identity when already empty", () => {
    const empty: string[] = [];
    expect(selectionReducer(empty, { type: "clear" })).toBe(empty);
    expect(selectionReducer(["C-001"], { type: "clear" })).toEqual([]);
  });

  it("prune drops ids that vanished after a poll", () => {
    const s = selectionReducer(["C-001", "C-009"], { type: "prune", ids: ["C-001", "C-002"] });
    expect(s).toEqual(["C-001"]);
    const same = ["C-001"];
    expect(selectionReducer(same, { type: "prune", ids: ["C-001"] })).toBe(same);
  });

  it("arrow keys move along the order and clamp at the ends", () => {
    const order = ["C-000", "C-001", "C-002"];
    expect(selectionReducer([], { type: "move", dir: 1, order })).toEqual(["C-000"]);
    expect(selectionReducer([], { type: "move", dir: -1, order })).toEqual(["C-002"]);
    expect(selectionReducer(["C-001"], { type: "move", dir: 1, order })).toEqual(["C-002"]);
    expect(selectionReducer(["C-002"], { type: "move", dir: 1, order })).toEqual(["C-002"]);
    expect(selectionReducer(["C-000"], { type: "move", dir: -1, order })).toEqual(["C-000"]);
  });

  it("orderedIds sorts by wave then id", () => {
    const mk = (id: string, wave: number) => ({ id, wave }) as PanelCell;
    expect(orderedIds([mk("C-003", 1), mk("C-001", 2), mk("C-002", 1)])).toEqual(["C-002", "C-003", "C-001"]);
  });
});
