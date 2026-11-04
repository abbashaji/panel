// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserve } from "../core/api";
import { usePanel } from "../core/store";
import LaunchProvider from "./index";
import RunReadyDialog from "./RunReadyDialog";
import { openUrl, startManyUrl, startUrl, syncUrl, transport } from "./protocol";

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

describe("startManyUrl", () => {
  it("builds the startmany link from valid input", () => {
    expect(startManyUrl(REPO, "Ann B", ["C-010", "C-011"])).toBe(
      "blueprint://startmany?repo=abbashaji%2Fpanel&who=Ann%20B&cells=C-010,C-011",
    );
    const twelve = Array.from({ length: 12 }, (_, i) => `C-${String(i + 1).padStart(3, "0")}`);
    expect(startManyUrl(REPO, "Ann", twelve).endsWith(`cells=${twelve.join(",")}`)).toBe(true);
  });

  it("refuses bad input", () => {
    expect(() => startManyUrl(REPO, "Ann", [])).toThrow();
    const thirteen = Array.from({ length: 13 }, (_, i) => `C-${String(i + 1).padStart(3, "0")}`);
    expect(() => startManyUrl(REPO, "Ann", thirteen)).toThrow();
    expect(() => startManyUrl(REPO, "Ann", ["C-001", "C-001"])).toThrow();
    expect(() => startManyUrl(REPO, "Ann", ["C-001", "C-1"])).toThrow();
    expect(() => startManyUrl(REPO, "Ann", ["C-001&x=1"])).toThrow();
    expect(() => startManyUrl("bad repo", "Ann", ["C-001"])).toThrow();
    expect(() => startManyUrl(REPO, "a&b", ["C-001"])).toThrow();
    expect(() => startManyUrl(REPO, "", ["C-001"])).toThrow();
  });

  it("refuses a link over 400 characters", () => {
    const repo = `${"a".repeat(100)}/${"b".repeat(100)}`;
    const ids = Array.from({ length: 12 }, (_, i) => `C-${String(i + 1).padStart(5, "0")}`);
    expect(() => startManyUrl(repo, " ".repeat(40), ids)).toThrow(/too long/);
  });
});

describe("RunReadyDialog", () => {
  const cell = (id: string, status: string) => ({ id, title: `Title ${id}`, status }) as never;
  const cells = [cell("C-001", "done"), cell("C-010", "ready"), cell("C-011", "running"), cell("C-012", "ready"), cell("C-013", "expired"), cell("C-014", "ready")];
  afterEach(cleanup);

  it("lists only ready cells, all ticked, with a counter and the profile hint", () => {
    render(<RunReadyDialog open onOpenChange={() => {}} cells={cells} onRun={() => {}} />);
    for (const id of ["C-010", "C-012", "C-014"]) expect(screen.getByText(id)).toBeTruthy();
    for (const id of ["C-001", "C-011", "C-013"]) expect(screen.queryByText(id)).toBeNull();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => b.checked)).toBe(true);
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run 3 cells" })).toBeTruthy();
    expect(screen.getByText(/next window lets you pick the browser profiles/)).toBeTruthy();
  });

  it("None and Select all change the selection", () => {
    render(<RunReadyDialog open onOpenChange={() => {}} cells={cells} onRun={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run 0 cells" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("3 selected")).toBeTruthy();
  });

  it("Run passes only the ticked cells and closes the dialog", () => {
    const onRun = vi.fn();
    const onOpenChange = vi.fn();
    render(<RunReadyDialog open onOpenChange={onOpenChange} cells={cells} onRun={onRun} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /C-012/ }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run 2 cells" }));
    expect(onRun).toHaveBeenCalledWith(["C-010", "C-014"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ticks at most 12 cells", () => {
    const many = Array.from({ length: 14 }, (_, i) => cell(`C-${String(i + 1).padStart(3, "0")}`, "ready"));
    render(<RunReadyDialog open onOpenChange={() => {}} cells={many} onRun={() => {}} />);
    expect(screen.getByText("12 selected")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.filter((b) => b.checked)).toHaveLength(12);
    expect(boxes.filter((b) => b.disabled)).toHaveLength(2);
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
  let registered: {
    start?: (id: string) => void;
    startMany?: (ids: string[]) => void;
    open?: (id: string) => void;
    owner?: (id: string) => string | null;
  } = {};
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

  it("startMany reserves one after another, drops failures and links only the reserved cells", async () => {
    window.localStorage.setItem("bp_who", "Ann");
    vi.mocked(reserve).mockImplementation(async (_repo: string, id: string) => {
      if (id === "C-013") return { status: "taken", detail: "Held by Bob" };
      if (id === "C-014") throw new Error("boom");
      return { status: "reserved", detail: "ok" };
    });
    registered.startMany!(["C-010", "C-013", "C-014", "C-015"]);
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(vi.mocked(reserve).mock.calls.map((c) => c[1])).toEqual(["C-010", "C-013", "C-014", "C-015"]);
    expect(go).toHaveBeenCalledWith("blueprint://startmany?repo=abbashaji%2Fpanel&who=Ann&cells=C-010,C-015");
    const said = toast.mock.calls.map((c) => String(c[0])).find((m) => m.includes("C-013"))!;
    expect(said).toContain("C-013 (taken)");
    expect(said).toContain("C-014 (error)");
    expect(said).not.toContain("C-010");
    expect(said).not.toContain("C-015");
    expect(registered.owner!("C-010")).toBe("Ann");
  });

  it("startMany shows the launcher missing hint when the page stays visible", async () => {
    window.localStorage.setItem("bp_who", "Ann");
    vi.mocked(reserve).mockResolvedValue({ status: "reserved", detail: "ok" });
    registered.startMany!(["C-010"]);
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(transport.watch).toHaveBeenCalledTimes(1);
    vi.mocked(transport.watch).mock.calls[0]![0]();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining("Install the launcher"), "info");
  });

  it("startMany opens nothing when every reserve fails", async () => {
    window.localStorage.setItem("bp_who", "Ann");
    vi.mocked(reserve).mockResolvedValue({ status: "taken", detail: "Held by Bob" });
    registered.startMany!(["C-010", "C-012"]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Not started: C-010 (taken), C-012 (taken)", "error"));
    expect(go).not.toHaveBeenCalled();
  });

  it("startMany asks for a name first when none is saved", async () => {
    vi.mocked(reserve).mockResolvedValue({ status: "reserved", detail: "ok" });
    registered.startMany!(["C-010", "C-012"]);
    const input = await screen.findByLabelText("Display name");
    expect(reserve).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Ann" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(go).toHaveBeenCalledWith("blueprint://startmany?repo=abbashaji%2Fpanel&who=Ann&cells=C-010,C-012");
    expect(window.localStorage.getItem("bp_who")).toBe("Ann");
  });

  it("startMany refuses more than 12 cells and reserves nothing", () => {
    window.localStorage.setItem("bp_who", "Ann");
    registered.startMany!(Array.from({ length: 13 }, (_, i) => `C-${String(i + 1).padStart(3, "0")}`));
    expect(toast).toHaveBeenCalledWith("Run at most 12 cells at once.", "error");
    expect(reserve).not.toHaveBeenCalled();
  });
});
