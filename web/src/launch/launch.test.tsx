// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserve } from "../core/api";
import { usePanel } from "../core/store";
import LaunchProvider from "./index";
import { openUrl, startUrl, syncUrl, transport } from "./protocol";

vi.mock("../core/store", () => ({ usePanel: vi.fn() }));
vi.mock("../core/api", () => ({ reserve: vi.fn() }));

const REPO = "abbashaji/panel";
const SYNC_ALL = `blueprint://sync?repo=abbashaji%2Fpanel&merged=C-001`;

describe("protocol builders", () => {
  it("build encoded URLs from valid input", () => {
    expect(startUrl(REPO, "C-010", "Ann B")).toBe("blueprint://start?repo=abbashaji%2Fpanel&cell=C-010&who=Ann%20B");
    expect(openUrl(REPO, "C-010")).toBe("blueprint://open?repo=abbashaji%2Fpanel&cell=C-010");
    expect(syncUrl(REPO, ["C-002", "C-001"])).toBe("blueprint://sync?repo=abbashaji%2Fpanel&merged=C-002,C-001");
  });

  it("refuse bad input", () => {
    for (const repo of ["", "x", "a b/c", "a/b/c", "a/b&x=1", "a/b\n"]) {
      expect(() => openUrl(repo, "C-001")).toThrow();
    }
    for (const cell of ["", "C-1", "c-001", "C-123456", "C-001&who=x", "C-001\n"]) {
      expect(() => openUrl(REPO, cell)).toThrow();
    }
    for (const who of ["", "a&b", "a=b", "x".repeat(41), "x\ny", "<b>"]) {
      expect(() => startUrl(REPO, "C-001", who)).toThrow();
    }
  });

  it("sync keeps only valid, unique ids and stays under 400 characters", () => {
    expect(syncUrl(REPO, ["C-001", "bad", "C-001", "C-1", "C-002&x"])).toBe("blueprint://sync?repo=abbashaji%2Fpanel&merged=C-001");
    expect(() => syncUrl(REPO, ["nope"])).toThrow();
    expect(() => syncUrl("bad repo", ["C-001"])).toThrow();
    const many = Array.from({ length: 200 }, (_, i) => `C-${String(i + 1).padStart(3, "0")}`);
    const url = syncUrl(REPO, many);
    expect(url.length).toBeLessThanOrEqual(400);
    for (const id of url.split("merged=")[1]!.split(",")) expect(id).toMatch(/^C-\d{3,5}$/);
  });
});

describe("transport.watch", () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("reports a missing launcher only when the page stayed visible", () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const stayed = vi.fn();
    transport.watch(stayed, 2000);
    vi.advanceTimersByTime(2000);
    expect(stayed).toHaveBeenCalledTimes(1);

    const left = vi.fn();
    transport.watch(left, 2000);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(2000);
    expect(left).not.toHaveBeenCalled();
  });
});

describe("LaunchProvider", () => {
  const toast = vi.fn();
  let registered: { start?: (id: string) => void; open?: (id: string) => void; owner?: (id: string) => string | null } = {};
  const state = {
    cells: [
      { id: "C-001", status: "done", reservedBy: null },
      { id: "C-010", status: "ready", reservedBy: null },
      { id: "C-011", status: "running", reservedBy: "Bob" },
      { id: "C-012", status: "expired", reservedBy: "Cy" },
    ],
  };
  const panel = {
    repo: REPO,
    state,
    toast,
    registerLauncher: (part: typeof registered) => {
      registered = part;
      return () => {};
    },
  };
  let go: ReturnType<typeof vi.spyOn>;
  let silent: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    toast.mockReset();
    registered = {};
    vi.mocked(usePanel).mockReturnValue(panel as never);
    vi.mocked(reserve).mockReset();
    go = vi.spyOn(transport, "go").mockImplementation(() => {});
    silent = vi.spyOn(transport, "silent").mockImplementation(() => {});
    vi.spyOn(transport, "watch").mockImplementation(() => {});
    render(
      <LaunchProvider>
        <div>child</div>
      </LaunchProvider>,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("registers the hooks and sends merged ids only", () => {
    expect(registered.start).toBeTypeOf("function");
    expect(registered.open).toBeTypeOf("function");
    expect(silent).toHaveBeenCalledWith(SYNC_ALL);
  });

  it("reserved: shows the dialog first, navigates only after the click", async () => {
    window.localStorage.setItem("bp_who", "Ann");
    vi.mocked(reserve).mockResolvedValue({ status: "reserved", detail: "ok" });
    registered.start!("C-010");
    await screen.findByRole("dialog");
    expect(reserve).toHaveBeenCalledWith(REPO, "C-010", "Ann");
    expect(go).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open claude.ai" }));
    expect(go).toHaveBeenCalledWith("blueprint://start?repo=abbashaji%2Fpanel&cell=C-010&who=Ann");
    expect(registered.owner!("C-010")).toBe("Ann");
  });

  it("taken: shows a toast and does not navigate", async () => {
    window.localStorage.setItem("bp_who", "Ann");
    vi.mocked(reserve).mockResolvedValue({ status: "taken", detail: "Held by Bob" });
    registered.start!("C-010");
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Held by Bob", "error"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });

  it("not_ready: shows a toast and does not navigate", async () => {
    window.localStorage.setItem("bp_who", "Ann");
    vi.mocked(reserve).mockResolvedValue({ status: "not_ready", detail: "Not ready" });
    registered.start!("C-010");
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Not ready", "info"));
    expect(go).not.toHaveBeenCalled();
  });

  it("asks for a name first when none is saved", async () => {
    vi.mocked(reserve).mockResolvedValue({ status: "reserved", detail: "ok" });
    registered.start!("C-010");
    const input = await screen.findByLabelText("Display name");
    fireEvent.change(input, { target: { value: "a&b" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(reserve).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Ann" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(reserve).toHaveBeenCalledWith(REPO, "C-010", "Ann"));
    expect(window.localStorage.getItem("bp_who")).toBe("Ann");
  });

  it("open works for any teammate on running and expired cells, but not on merged cells", () => {
    expect(registered.owner!("C-011")).toBe("Bob");
    registered.open!("C-011");
    expect(go).toHaveBeenCalledWith("blueprint://open?repo=abbashaji%2Fpanel&cell=C-011");

    go.mockClear();
    registered.open!("C-012");
    expect(go).toHaveBeenCalledWith("blueprint://open?repo=abbashaji%2Fpanel&cell=C-012");

    go.mockClear();
    registered.open!("C-001");
    expect(go).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("C-001 is merged; there is no chat to open.", "info");
  });

  it("never shows the owner-only toast", () => {
    registered.open!("C-011");
    registered.open!("C-012");
    registered.open!("C-010");
    for (const call of toast.mock.calls) expect(String(call[0])).not.toContain("Only the person");
  });
});
