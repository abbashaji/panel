// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, clearFeedback, release } from "../core/api";
import type { PanelCell, PanelStatus } from "../core/types";
import Inspector from "./index";

const h = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));
vi.mock("../core/store", () => ({ usePanel: () => h.ctx }));
vi.mock("../core/api", async (orig) => ({
  ...(await orig<typeof import("../core/api")>()),
  release: vi.fn(),
  clearFeedback: vi.fn(),
}));

function cell(id: string, status: PanelStatus, extra: Partial<PanelCell> = {}): PanelCell {
  return {
    id,
    title: `Title ${id}`,
    type: "normal",
    priority: 0,
    status,
    critical: false,
    wave: 1,
    depends: [],
    blockedBy: [],
    directDependents: 0,
    transitiveDependents: 0,
    sha: { lock: "7d3e1b0", tip: "9b20c4e", merged: null },
    lease: status === "running" ? { minutesLeft: 42, expiredMinutesAgo: null, ci: false } : null,
    attempts: 1,
    maxAttempts: 3,
    lastCommit: { subject: "wip subject", next: "do the next thing", at: "2026-11-04T10:00:00Z" },
    reservedBy: null,
    pr: { number: 12, state: "open" },
    allowedPaths: ["web/src/inspector/**"],
    provides: [],
    inputs: [],
    ...extra,
  };
}

function setup(cells: PanelCell[], selection: string[], extra: Record<string, unknown> = {}) {
  const fns = {
    toast: vi.fn(),
    refresh: vi.fn(),
    launcher: { start: vi.fn(), open: vi.fn(), sync: vi.fn(), owner: vi.fn(() => "Sam") },
    registerActions: vi.fn(() => () => {}),
  };
  h.ctx = {
    repo: "o/r",
    state: { repo: "o/r", project: "p", mainSha: "abc1234", generatedAt: "x", counts: {}, cells, bottleneck: null },
    selection,
    ...fns,
    ...extra,
  };
  return fns;
}

const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

describe("Inspector", () => {
  it("shows the selected cell details", () => {
    setup([cell("C-006", "running")], ["C-006"]);
    render(<Inspector />);
    expect(screen.getByText("Title C-006")).toBeTruthy();
    expect(screen.getByTestId("status-chip").textContent).toContain("Running");
    expect(screen.getByText("42 min left · attempt 1 of 3")).toBeTruthy();
    expect(screen.getByText("7d3e1b0")).toBeTruthy();
    expect(screen.getByText("9b20c4e")).toBeTruthy();
    expect(screen.getByText("1 allowed path")).toBeTruthy();
    expect(screen.getByText("0 direct, 0 total dependents")).toBeTruthy();
    expect(screen.getByText("cell/C-006")).toBeTruthy();
    expect(screen.getByText(/wip subject · \d+(m|h|d) ago/)).toBeTruthy();
    expect(screen.getByText("do the next thing")).toBeTruthy();
    expect(screen.getByText("Sam")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    const pr = screen.getByText(/#12/).closest("a") as HTMLAnchorElement;
    expect(pr.href).toBe("https://github.com/o/r/pull/12");
    const branch = screen.getByText("Open branch on GitHub") as HTMLAnchorElement;
    expect(branch.href).toBe("https://github.com/o/r/tree/cell/C-006");
  });

  it("summarises a multi-selection", () => {
    setup([cell("C-001", "ready"), cell("C-002", "done")], ["C-001", "C-002"]);
    render(<Inspector />);
    expect(screen.getByText("2 cells selected")).toBeTruthy();
    expect(screen.queryByTestId("cell-details")).toBeNull();
  });

  it("Open chat and Start call the launcher", () => {
    const fns = setup([cell("C-006", "running"), cell("C-007", "ready")], ["C-006"]);
    render(<Inspector />);
    fireEvent.click(btn("Open chat"));
    expect(fns.launcher.open).toHaveBeenCalledWith("C-006");
    cleanup();
    setup([cell("C-007", "ready")], ["C-007"], { launcher: fns.launcher });
    render(<Inspector />);
    fireEvent.click(btn("Start"));
    expect(fns.launcher.start).toHaveBeenCalledWith("C-007");
  });

  it("offers an enabled Open chat button on a cell reserved by another person", () => {
    const fns = setup([cell("C-006", "running", { reservedBy: "Alex" })], ["C-006"], {
      launcher: { start: vi.fn(), open: vi.fn(), sync: vi.fn(), owner: vi.fn(() => "Sam") },
    });
    render(<Inspector />);
    expect(screen.getByText("Alex")).toBeTruthy();
    const open = btn("Open chat");
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    expect((h.ctx.launcher as typeof fns.launcher).open).toHaveBeenCalledWith("C-006");
  });

  it("hides Release cell on done and waiting cells", () => {
    for (const status of ["done", "waiting"] as PanelStatus[]) {
      setup([cell("C-006", status)], ["C-006"]);
      render(<Inspector />);
      expect(screen.queryByRole("button", { name: "Release cell" })).toBeNull();
      cleanup();
    }
    setup([cell("C-006", "running")], ["C-006"]);
    render(<Inspector />);
    expect(btn("Release cell").disabled).toBe(false);
  });

  it("confirm dialog names the exact git write", () => {
    setup([cell("C-006", "running")], ["C-006"]);
    render(<Inspector />);
    fireEvent.click(btn("Release cell"));
    const dlg = screen.getByRole("dialog");
    expect(dlg.textContent).toMatch(/ONE empty commit/);
    expect(dlg.textContent).toContain("cell/C-006");
    expect(dlg.textContent).toMatch(/never stored/);
  });

  it("clear feedback dialog names the branch state change", () => {
    setup([cell("C-006", "needs_human")], ["C-006"]);
    render(<Inspector />);
    fireEvent.click(btn("Clear feedback"));
    expect(screen.getByRole("dialog").textContent).toMatch(/branch state/);
    expect(clearFeedback).not.toHaveBeenCalled();
  });

  it("sends the typed admin key once, never persists it, and toasts the result", async () => {
    vi.mocked(release).mockResolvedValue({ text: "released C-006" });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fns = setup([cell("C-006", "running")], ["C-006"]);
    render(<Inspector />);
    fireEvent.click(btn("Release cell"));
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: "topsecret" } });
    fireEvent.click(btn("Release C-006"));
    await waitFor(() => expect(release).toHaveBeenCalledWith("o/r", "C-006", "topsecret"));
    await waitFor(() => expect(fns.toast).toHaveBeenCalledWith("released C-006", "success"));
    expect(fns.refresh).toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).not.toContain("topsecret");
    // reopen: the field is empty again
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(btn("Release cell"));
    expect((screen.getByLabelText(/admin key/i) as HTMLInputElement).value).toBe("");
    setItem.mockRestore();
  });

  it("says the key was wrong on 403 and keeps the dialog open", async () => {
    vi.mocked(release).mockRejectedValue(new ApiError(403, "forbidden"));
    const fns = setup([cell("C-006", "running")], ["C-006"]);
    render(<Inspector />);
    fireEvent.click(btn("Release cell"));
    fireEvent.change(screen.getByLabelText(/admin key/i), { target: { value: "nope" } });
    fireEvent.click(btn("Release C-006"));
    await waitFor(() => expect(fns.toast).toHaveBeenCalledWith("Wrong admin key.", "error"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText(/admin key/i) as HTMLInputElement).value).toBe("");
  });

  it("registers requestRelease so the graph banner can open the dialog", () => {
    let part: { requestRelease(id: string): void } | undefined;
    setup([cell("C-006", "running")], [], {
      registerActions: vi.fn((p: { requestRelease(id: string): void }) => {
        part = p;
        return () => {};
      }),
    });
    render(<Inspector />);
    expect(part).toBeDefined();
    act(() => part!.requestRelease("C-006"));
    expect(screen.getByRole("dialog").textContent).toContain("Release C-006?");
  });

  it("shows the expired lease caption, the critical subline and a full bar", () => {
    setup(
      [cell("C-004", "expired", { lease: { minutesLeft: 0, expiredMinutesAgo: 22, ci: false }, attempts: 2, critical: true, directDependents: 5, transitiveDependents: 8 })],
      ["C-004"],
    );
    render(<Inspector />);
    expect(screen.getByText("Lease expired 22 min ago · attempt 2 of 3")).toBeTruthy();
    expect(screen.getByText("Critical cell · 5 direct, 8 total dependents")).toBeTruthy();
    expect(screen.getByTestId("status-chip").textContent).toContain("Lease expired");
    expect(btn("Open chat")).toBeTruthy();
    expect(btn("Release cell").disabled).toBe(false);
  });

  it("shows an em dash when nobody holds the cell and hides buttons that do not apply", () => {
    const launcher = { start: vi.fn(), open: vi.fn(), sync: vi.fn(), owner: vi.fn(() => null) };
    setup([cell("C-007", "ready")], ["C-007"], { launcher });
    render(<Inspector />);
    expect(screen.getByText("\u2014")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
    expect(btn("Start")).toBeTruthy();
  });

  it("shows a quiet hint when nothing is selected", () => {
    setup([cell("C-006", "running")], []);
    render(<Inspector />);
    expect(screen.getByText("Select a cell to see its details.")).toBeTruthy();
  });
});


// ---- C-031: refreshAfterAction + ReleaseDialog ----
import { QueryClient as C031QC, QueryClientProvider as C031QCP } from "@tanstack/react-query";
import { cleanup as c031Cleanup, render as c031Render, screen as c031Screen, waitFor as c031WaitFor, act as c031Act } from "@testing-library/react";
import { afterEach as c031After, beforeEach as c031Before, describe as c031Describe, expect as c031Expect, it as c031It, vi as c031Vi } from "vitest";
import { isMock as c031IsMock, setMockMode as c031SetMock } from "../core/api";
import type { PanelContextValue as C031Ctx } from "../core/store";
import { ReleaseDialog } from "./ReleaseDialog";

c031Describe("refreshAfterAction (C-031)", () => {
  const wasMock = c031IsMock();
  let savedRetry: number[] = [];
  let real: typeof import("../core/store");
  let serverStatus = "running";
  let stateCalls = 0;
  let bodies: string[] = [];
  let panel: C031Ctx;
  let qc: C031QC;

  function Probe() {
    panel = real.usePanel();
    return (
      <div>
        <div data-testid="st">{panel.state?.cells[0]?.status ?? "none"}</div>
        <div data-testid="owner">{String(panel.state?.cells[0]?.reservedBy ?? "nobody")}</div>
        <div data-testid="toasts">{panel.toasts.map((t) => t.msg).join("|")}</div>
      </div>
    );
  }

  function mount(extra?: JSX.Element) {
    qc = new C031QC({ defaultOptions: { queries: { retry: false } } });
    return c031Render(
      <C031QCP client={qc}>
        <real.PanelProvider>
          <Probe />
          {extra}
        </real.PanelProvider>
      </C031QCP>,
    );
  }

  c031Before(async () => {
    real = await c031Vi.importActual<typeof import("../core/store")>("../core/store");
    savedRetry = [...real.ACTION_RETRY_MS];
    c031SetMock(false);
    serverStatus = "running";
    stateCalls = 0;
    bodies = [];
    real.ACTION_RETRY_MS.splice(0, real.ACTION_RETRY_MS.length, 0, 30, 60, 90);
    window.history.replaceState(null, "", "/?repo=a/b");
    c031Vi.stubGlobal(
      "fetch",
      c031Vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.body) bodies.push(String(init.body));
        if (String(url).includes("/state")) {
          stateCalls++;
          return new Response(
            JSON.stringify({ repo: "a/b", cells: [{ id: "C-031", status: serverStatus, resumable: false, reservedBy: "alice" }] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ result: "Released. Ready to resume.", cell: { id: "C-031", status: "ready", resumable: true } }),
          { status: 200 },
        );
      }),
    );
  });
  c031After(() => {
    c031Cleanup();
    c031Vi.unstubAllGlobals();
    real.ACTION_RETRY_MS.splice(0, real.ACTION_RETRY_MS.length, ...savedRetry);
    c031SetMock(wasMock);
    window.history.replaceState(null, "", "/");
  });

  c031It("patches at once and a stale refetch does not flip it back", async () => {
    mount();
    await c031WaitFor(() => c031Expect(c031Screen.getByTestId("st").textContent).toBe("running"));
    let p: Promise<void> = Promise.resolve();
    c031Act(() => {
      p = panel.refreshAfterAction("C-031", { status: "ready", resumable: true, clearOwner: true });
    });
    c031Expect(c031Screen.getByTestId("st").textContent).toBe("ready");
    c031Expect(c031Screen.getByTestId("owner").textContent).toBe("nobody");
    // the server keeps answering with the old status: the retries run but the patch stays
    await c031WaitFor(() => c031Expect(stateCalls).toBeGreaterThanOrEqual(3));
    c031Expect(c031Screen.getByTestId("st").textContent).toBe("ready");
    await c031Act(async () => {
      await p;
    });
    c031Expect(stateCalls).toBe(5); // 1 initial + 4 retries
  });

  c031It("stops retrying as soon as the status matches", async () => {
    mount();
    await c031WaitFor(() => c031Expect(stateCalls).toBe(1));
    serverStatus = "ready";
    await c031Act(async () => {
      await panel.refreshAfterAction("C-031", { status: "ready", resumable: true });
    });
    c031Expect(stateCalls).toBe(2);
    await c031Act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    c031Expect(stateCalls).toBe(2);
    c031Expect(c031Screen.getByTestId("st").textContent).toBe("ready");
  });
, async () => {
    const view = mount();
    await c031WaitFor(() => c031Expect(stateCalls).toBe(1));
    real.ACTION_RETRY_MS.splice(0, real.ACTION_RETRY_MS.length, 0, 60, 120);
    c031Act(() => {
      void panel.refreshAfterAction("C-031", { status: "ready" });
    });
    await c031WaitFor(() => c031Expect(stateCalls).toBe(2));
    view.unmount();
    await new Promise((r) => setTimeout(r, 200));
    c031Expect(stateCalls).toBe(2);
  });
});
