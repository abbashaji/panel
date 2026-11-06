// Full-app integration test: the REAL App (all slots loaded by its import.meta.glob) in jsdom, talking to the fake Worker.
// Fake timers (shouldAdvanceTime) drive the 5 s poll; no network and no real clock dependency.
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { setMockMode } from "../core/api";
import { STATUS_META } from "../core/status";
import { POLL_MS } from "../core/store";
import { transport } from "../launch/protocol";
import { ADMIN_KEY, NOW, REPO, createFakeWorker, type FakeWorker } from "./fakeWorker";

const WHO = "Tester";
const REPO_Q = "abbashaji%2Fpanel";

let go: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  window.localStorage.setItem("bp_repo", REPO);
  window.localStorage.setItem("bp_who", WHO);
  window.history.replaceState({}, "", "/");
  setMockMode(false);
  focusManager.setFocused(true);
  // jsdom has none of these; React Flow needs them
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  class Matrix {
    m22 = 1;
  }
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("DOMMatrixReadOnly", Matrix);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  go = vi.spyOn(transport, "go").mockImplementation(() => {});
  vi.spyOn(transport, "silent").mockImplementation(() => {});
  vi.spyOn(transport, "watch").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Mounts the real app against a fresh fake and waits for the first state. */
async function mount(fake: FakeWorker): Promise<void> {
  vi.stubGlobal("fetch", fake.fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  await screen.findByRole("img", { name: /merged/ });
}

/** One poll interval plus a little, with the fake clock. */
async function poll(ms = POLL_MS + 100): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openPalette(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Search cells" }));
  return screen.findByRole("listbox", { name: "Matching cells" });
}

async function selectCell(id: string): Promise<void> {
  await openPalette();
  fireEvent.click(document.getElementById(`palette-${id}`) as HTMLElement);
  await screen.findByTestId("cell-details");
}

/** The graph card of a cell (its aria-label starts with the id). */
const card = (id: string): Element | null => document.querySelector(`[aria-label^="${id},"]`);
const cardLabel = (id: string, status: keyof typeof STATUS_META, title: string): string =>
  `${id}, ${STATUS_META[status].label}: ${title}`;

describe("panel app with a fake Worker", () => {
  it("1. shows Start steward when the steward is none and opens blueprint://steward through the transport", async () => {
    const fake = createFakeWorker();
    await mount(fake);
    expect(screen.queryByRole("button", { name: "Resume steward" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Start steward" }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(`blueprint://steward?repo=${REPO_Q}&who=${WHO}`);
  });

  it("2. releasing a running cell with the admin key changes the card at once and after the poll", async () => {
    const fake = createFakeWorker();
    await mount(fake);
    expect(card("C-002")?.getAttribute("aria-label")).toBe(cardLabel("C-002", "running", "Graph view"));
    await screen.findByText("Run ready (3)");

    await selectCell("C-002");
    fireEvent.click(screen.getByRole("button", { name: "Release cell" }));
    const key = await waitFor(() => {
      const el = document.getElementById("bp-admin-key");
      if (!el) throw new Error("admin key field is not open yet");
      return el as HTMLInputElement;
    });
    fireEvent.change(key, { target: { value: ADMIN_KEY } });
    fireEvent.click(screen.getByRole("button", { name: "Release C-002" }));

    await waitFor(() => expect(fake.requests("/release")).toHaveLength(1));
    expect(fake.requests("/release")[0].body).toEqual({ repo: REPO, cell_id: "C-002", admin_key: ADMIN_KEY });

    // right away: the cached cell is patched before any poll
    await screen.findByText("Run ready (4)");
    expect(card("C-002")?.getAttribute("aria-label")).toBe(cardLabel("C-002", "ready", "Graph view"));
    expect(await screen.findByTestId("resume-chip")).toBeTruthy();

    // after the polling interval the fake serves the same state
    const before = fake.requests("/state").length;
    await poll(POLL_MS + 9000);
    expect(fake.requests("/state").length).toBeGreaterThan(before);
    expect(card("C-002")?.getAttribute("aria-label")).toBe(cardLabel("C-002", "ready", "Graph view"));
    expect(screen.getByText("Run ready (4)")).toBeTruthy();
    expect(screen.getByTestId("resume-chip")).toBeTruthy();
  });

  it("3. a replaced cell is not on the graph and not counted", async () => {
    const fake = createFakeWorker();
    await mount(fake);
    expect(card("C-001")).not.toBeNull(); // the graph really rendered
    expect(card("C-004")).not.toBeNull();
    expect(card("C-009")).toBeNull();
    // 8 visible cells, 1 merged, 1 running, 1 expired; C-009 is ready but replaced, so Run ready counts 3
    expect(screen.getByRole("img", { name: "1 of 8 merged, 1 running, 1 lease expired" })).toBeTruthy();
    expect(screen.getByText("Run ready (3)")).toBeTruthy();
    expect(screen.queryByText(/C-009/)).toBeNull();
  });

  it("4. Run ready lists only ready cells, reserves the selected ones and opens one startmany URL", async () => {
    const fake = createFakeWorker();
    await mount(fake);
    fireEvent.click(await screen.findByRole("button", { name: "Run ready (3)" }));
    const dialog = await screen.findByRole("dialog");
    const rows = within(dialog).getAllByRole("checkbox");
    expect(rows).toHaveLength(3);
    for (const id of ["C-003", "C-004", "C-006"]) expect(within(dialog).getByText(id)).toBeTruthy();
    for (const id of ["C-001", "C-002", "C-005", "C-007", "C-008", "C-009"]) expect(within(dialog).queryByText(id)).toBeNull();

    // untick C-004 (second row), then run the other two
    fireEvent.click(rows[1]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Run 2 cells" }));

    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(go).toHaveBeenCalledWith(`blueprint://startmany?repo=${REPO_Q}&who=${WHO}&cells=C-003,C-006`);
    expect(fake.requests("/reserve").map((c) => c.body?.cell_id)).toEqual(["C-003", "C-006"]);
    expect(fake.state.cells.find((c) => c.id === "C-004")?.reservedBy).toBeNull();
  });
