import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.hoisted(() => vi.fn());
const STATUSES = ["done", "running", "ready", "waiting", "expired", "needs_human", "needs_split"];

// 14 cells; ids are deliberately not in wave order so the sort is exercised.
const cells = vi.hoisted(() => {
  const statuses = ["done", "running", "ready", "waiting", "expired", "needs_human", "needs_split"];
  return Array.from({ length: 14 }, (_, i) => {
    const n = 14 - i;
    return {
      id: `C-${String(n).padStart(3, "0")}`,
      title: `Cell title ${n}`,
      status: statuses[n % statuses.length],
      wave: 1 + Math.floor((n - 1) / 5),
    };
  });
});

vi.mock("../core/store", () => ({
  usePanel: () => ({ state: { cells }, select }),
}));

import Palette from "./Palette";

const ids = () => screen.getAllByRole("option").map((o) => o.id.replace("palette-", ""));
const box = () => screen.getByRole("combobox");

beforeEach(() => {
  select.mockClear();
});
afterEach(cleanup);

describe("Palette", () => {
  it("lists every cell on open, ordered by wave then id", () => {
    render(<Palette open onOpenChange={() => {}} />);
    expect(STATUSES.length).toBe(7);
    const got = ids();
    expect(got.length).toBe(14);
    const expected = [...cells]
      .sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id))
      .map((c) => c.id);
    expect(got).toEqual(expected);
    expect(screen.getByTestId("palette-count").textContent).toBe("14 cells");
  });

  it("shows wave and status label on each row", () => {
    render(<Palette open onOpenChange={() => {}} />);
    const first = screen.getAllByRole("option")[0];
    expect(first.textContent).toContain("Wave 1");
    expect(first.querySelector("svg")).not.toBeNull();
  });

  it("narrows live by id and title, case-insensitively, with M of N caption", () => {
    render(<Palette open onOpenChange={() => {}} />);
    fireEvent.change(box(), { target: { value: "c-007" } });
    expect(ids()).toEqual(["C-007"]);
    expect(screen.getByTestId("palette-count").textContent).toBe("1 of 14");
    fireEvent.change(box(), { target: { value: "CELL TITLE 12" } });
    expect(ids()).toEqual(["C-012"]);
  });

  it("finds cells by status label", () => {
    render(<Palette open onOpenChange={() => {}} />);
    fireEvent.change(box(), { target: { value: "merged" } });
    const merged = cells.filter((c) => c.status === "done").map((c) => c.id).sort();
    expect(ids().sort()).toEqual(merged);
    fireEvent.change(box(), { target: { value: "expired" } });
    const expired = cells.filter((c) => c.status === "expired").map((c) => c.id).sort();
    expect(ids().sort()).toEqual(expired);
  });

  it("shows 'No matching cells' for an empty result", () => {
    render(<Palette open onOpenChange={() => {}} />);
    fireEvent.change(box(), { target: { value: "zzzz-nothing" } });
    expect(screen.queryAllByRole("option").length).toBe(0);
    expect(screen.getByText("No matching cells")).toBeTruthy();
  });

  it("does not cap results at 8", () => {
    render(<Palette open onOpenChange={() => {}} />);
    expect(screen.getAllByRole("option").length).toBeGreaterThan(8);
    fireEvent.change(box(), { target: { value: "cell" } });
    expect(screen.getAllByRole("option").length).toBe(14);
  });

  it("moves with arrows, Home and End and selects with Enter", () => {
    const onOpenChange = vi.fn();
    render(<Palette open onOpenChange={onOpenChange} />);
    const order = ids();
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).toBe(`palette-${order[2]}`);
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().getAttribute("aria-activedescendant")).toBe(`palette-${order[1]}`);
    fireEvent.keyDown(box(), { key: "End" });
    expect(box().getAttribute("aria-activedescendant")).toBe(`palette-${order[13]}`);
    fireEvent.keyDown(box(), { key: "Home" });
    expect(box().getAttribute("aria-activedescendant")).toBe(`palette-${order[0]}`);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(select).toHaveBeenCalledWith(order[1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("highlights the active row", () => {
    render(<Palette open onOpenChange={() => {}} />);
    const rows = screen.getAllByRole("option");
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
  });

  it("selects and closes on click", () => {
    const onOpenChange = vi.fn();
    render(<Palette open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("option", { name: /C-009/ }));
    expect(select).toHaveBeenCalledWith("C-009");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("has a scrollable list container", () => {
    render(<Palette open onOpenChange={() => {}} />);
    const list = screen.getByRole("listbox");
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.maxHeight).toBe("60vh");
  });

  it("keeps the combobox and listbox wiring", () => {
    render(<Palette open onOpenChange={() => {}} />);
    expect(box().getAttribute("aria-controls")).toBe("palette-list");
    expect(screen.getByRole("listbox").id).toBe("palette-list");
  });
});
