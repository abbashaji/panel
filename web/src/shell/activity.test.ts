import { describe, expect, it } from "vitest";
import type { PanelCell } from "../core/types";
import { deriveActivity, initials, progress } from "./activity";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function cell(id: string, status: PanelCell["status"], over: Partial<PanelCell> = {}): PanelCell {
  return {
    id,
    title: id,
    type: "normal",
    priority: 0,
    status,
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

describe("deriveActivity", () => {
  const cells = [
    cell("C-001", "done", { lastCommit: { subject: "cell(C-001): ship", next: null, at: iso(180) } }),
    cell("C-002", "running", { lastCommit: { subject: "work in progress", next: null, at: iso(5) } }),
    cell("C-003", "expired", {
      attempts: 2,
      lease: { minutesLeft: 0, expiredMinutesAgo: 22, ci: false },
      lastCommit: { subject: "routes WIP", next: null, at: iso(82) },
    }),
    cell("C-004", "waiting", { lastCommit: { subject: "ignored", next: null, at: iso(1) } }),
    cell("C-005", "needs_human", { lastCommit: { subject: "feedback", next: null, at: iso(30) } }),
  ];

  it("orders newest first and skips waiting cells", () => {
    const rows = deriveActivity(cells, NOW);
    expect(rows.map((r) => r.cellId)).toEqual(["C-002", "C-003", "C-005", "C-003", "C-001"]);
  });

  it("maps statuses to icon kinds and texts", () => {
    const rows = deriveActivity(cells, NOW);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["C-002:commit"]?.kind).toBe("heartbeat");
    expect(byKey["C-003:expired"]?.kind).toBe("warning");
    expect(byKey["C-003:expired"]?.text).toBe("C-003 lease expired 22 min ago (attempt 2 of 3)");
    expect(byKey["C-001:merged"]?.kind).toBe("merged");
    expect(byKey["C-005:human"]?.text).toBe("C-005 needs the steward");
  });

  it("formats HH:MM and honours the limit", () => {
    const rows = deriveActivity(cells, NOW, 2);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.time).toMatch(/^\d\d:\d\d$/);
  });

  it("ignores unparsable timestamps", () => {
    const bad = [cell("C-009", "running", { lastCommit: { subject: "x", next: null, at: "not a date" } })];
    expect(deriveActivity(bad, NOW)).toEqual([]);
  });
});

describe("progress", () => {
  it("counts merged, running and expired as shares of all cells", () => {
    const cells = [cell("C-001", "done"), cell("C-002", "done"), cell("C-003", "running"), cell("C-004", "expired"), cell("C-005", "waiting"), cell("C-006", "waiting"), cell("C-007", "ready"), cell("C-008", "waiting")];
    const p = progress(cells);
    expect(p).toMatchObject({ total: 8, merged: 2, running: 1, expired: 1 });
    expect(p.pct.merged).toBe(25);
    expect(p.pct.running).toBe(12.5);
    expect(p.pct.expired).toBe(12.5);
  });

  it("an empty plan has zero shares", () => {
    expect(progress([]).pct).toEqual({ merged: 0, running: 0, expired: 0 });
  });
});

describe("initials", () => {
  it("takes two initials from two words, else the first two letters", () => {
    expect(initials("Ali Work")).toBe("AW");
    expect(initials("sara.k")).toBe("SK");
    expect(initials("omar")).toBe("OM");
    expect(initials("")).toBe("Y");
  });
});
