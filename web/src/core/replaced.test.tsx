import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { PanelCell, PanelState } from "./types";

vi.mock("./api", async (orig) => ({ ...(await orig<typeof import("./api")>()), getState: vi.fn() }));

import { getState } from "./api";
import { PanelProvider, usePanel } from "./store";

function cell(id: string, extra: Partial<PanelCell> = {}): PanelCell {
  return {
    id,
    title: `Title ${id}`,
    type: "normal",
    priority: 1,
    status: "ready",
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
    ...extra,
  };
}

function panelState(cells: PanelCell[], bottleneck: PanelState["bottleneck"] = null): PanelState {
  return {
    repo: "a/b",
    project: "p",
    mainSha: "abcdef0",
    generatedAt: "2026-01-01T00:00:00Z",
    counts: { done: 1, running: 0, ready: 1, waiting: 0, expired: 0, needs_human: 0, needs_split: 0 },
    cells,
    bottleneck,
  };
}

function mount(s: PanelState) {
  vi.mocked(getState).mockResolvedValue(s);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <PanelProvider>{children}</PanelProvider>
    </QueryClientProvider>
  );
  return renderHook(() => usePanel(), { wrapper });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/?repo=a/b");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replaced cells", () => {
  const base = () =>
    panelState(
      [
        cell("C-036", { supersededBy: ["C-043"] }),
        cell("C-043", { depends: [{ id: "C-036", kind: "implementation" }], blockedBy: ["C-036"] }),
        cell("C-001"),
      ],
      { id: "C-036", blocks: 2 },
    );

  it("hides a replaced cell by default, with its edges and bottleneck", async () => {
    const { result } = mount(base());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.showReplaced).toBe(false);
    const ids = result.current.state!.cells.map((c) => c.id);
    expect(ids).toEqual(["C-043", "C-001"]);
    const c43 = result.current.state!.cells.find((c) => c.id === "C-043")!;
    expect(c43.depends).toEqual([]);
    expect(c43.blockedBy).toEqual([]);
    expect(result.current.state!.bottleneck).toBeNull();
  });

  it("shows it again with the suffix when showReplaced is true", async () => {
    const { result } = mount(base());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => result.current.setShowReplaced(true));
    const c = result.current.state!.cells.find((x) => x.id === "C-036");
    expect(c?.title).toBe("Title C-036 (replaced by C-043)");
    expect(window.localStorage.getItem("bp_show_replaced")).toBe("1");
  });

  it("never hides a plain cell", async () => {
    const { result } = mount(panelState([cell("C-001"), cell("C-002", { supersededBy: [] })]));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state!.cells.map((c) => c.id)).toEqual(["C-001", "C-002"]);
  });

  it("leaves a state without supersededBy (old Worker) unchanged", async () => {
    const s = panelState([cell("C-001"), cell("C-002")], { id: "C-001", blocks: 1 });
    const { result } = mount(s);
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state).toEqual(s);
  });

  it("does not throw when storage fails", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = mount(base());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.showReplaced).toBe(false);
    expect(() => act(() => result.current.setShowReplaced(true))).not.toThrow();
    expect(result.current.showReplaced).toBe(true);
  });
});
