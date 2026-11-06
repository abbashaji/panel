import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PanelSteward } from "../core/types";

const api = vi.hoisted(() => ({ stewardRelease: vi.fn() }));
const panel = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("../core/api", async (orig) => ({ ...(await orig<typeof import("../core/api")>()), stewardRelease: api.stewardRelease }));
vi.mock("../core/store", () => ({ usePanel: () => panel.current }));

import StewardChip from "./StewardChip";

const base: PanelSteward = { status: "none", holder: null, minutesLeft: null, expiredMinutesAgo: null, problems: 0 };
const startSteward = vi.fn();
const toast = vi.fn();
const refresh = vi.fn(() => Promise.resolve());

function setPanel(steward: PanelSteward | undefined, withStart = true) {
  panel.current = {
    repo: "acme/panel",
    state: steward ? { steward, cells: [] } : { cells: [] },
    launcher: withStart ? { startSteward } : {},
    toast,
    refresh,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.stewardRelease.mockResolvedValue({ ok: true, result: "Steward released.", steward: { ...base, status: "released" } });
});
afterEach(cleanup);

describe("StewardChip statuses and buttons", () => {
  it("none: idle text, problem count, Start only", () => {
    setPanel({ ...base, problems: 3 });
    render(<StewardChip />);
    expect(screen.getByText("Steward idle")).toBeTruthy();
    expect(screen.getByText("3 problems")).toBeTruthy();
    expect(screen.getByText("Start steward")).toBeTruthy();
    expect(screen.queryByText("Resume steward")).toBeNull();
    expect(screen.queryByText("Release")).toBeNull();
    fireEvent.click(screen.getByText("Start steward"));
    expect(startSteward).toHaveBeenCalledTimes(1);
  });

  it("active: holder and time left, Release only", () => {
    setPanel({ ...base, status: "active", holder: "alice", minutesLeft: 41 });
    render(<StewardChip />);
    expect(screen.getByText("Steward active, alice, 41m left")).toBeTruthy();
    expect(screen.getByText("Release")).toBeTruthy();
    expect(screen.queryByText("Start steward")).toBeNull();
    expect(screen.queryByText("Resume steward")).toBeNull();
  });

  it("expired: expired ago, Resume and Release", () => {
    setPanel({ ...base, status: "expired", expiredMinutesAgo: 12 });
    render(<StewardChip />);
    expect(screen.getByText("Steward expired 12m ago")).toBeTruthy();
    expect(screen.getByText("Resume steward")).toBeTruthy();
    expect(screen.getByText("Release")).toBeTruthy();
    expect(screen.queryByText("Start steward")).toBeNull();
    fireEvent.click(screen.getByText("Resume steward"));
    expect(startSteward).toHaveBeenCalledTimes(1);
  });

  it("released: released text, Resume only", () => {
    setPanel({ ...base, status: "released" });
    render(<StewardChip />);
    expect(screen.getByText("Steward released")).toBeTruthy();
    expect(screen.getByText("Resume steward")).toBeTruthy();
    expect(screen.queryByText("Release")).toBeNull();
    expect(screen.queryByText("Start steward")).toBeNull();
  });

  it("hides Start and Resume when launcher.startSteward is missing", () => {
    setPanel({ ...base }, false);
    const { unmount } = render(<StewardChip />);
    expect(screen.queryByText("Start steward")).toBeNull();
    unmount();
    setPanel({ ...base, status: "expired", expiredMinutesAgo: 5 }, false);
    render(<StewardChip />);
    expect(screen.queryByText("Resume steward")).toBeNull();
    expect(screen.getByText("Release")).toBeTruthy();
  });

  it("renders nothing when state.steward is undefined (old Worker)", () => {
    setPanel(undefined);
    const { container } = render(<StewardChip />);
    expect(container.innerHTML).toBe("");
  });
});

describe("StewardChip release flow", () => {
  it("calls the API once with the typed key and clears it", async () => {
    setPanel({ ...base, status: "active", holder: "alice", minutesLeft: 41 });
    render(<StewardChip />);
    fireEvent.click(screen.getByText("Release"));
    expect(screen.getByText("Release the Steward?")).toBeTruthy();

    const input = screen.getByLabelText(/Admin key/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "k3y" } });
    fireEvent.click(screen.getByRole("button", { name: "Release the Steward" }));

    await waitFor(() => expect(api.stewardRelease).toHaveBeenCalledTimes(1));
    expect(api.stewardRelease).toHaveBeenCalledWith("acme/panel", "k3y");
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Steward released.", "success"));
    expect(refresh).toHaveBeenCalled();

    // the dialog closed; opening it again shows an empty key field
    await waitFor(() => expect(screen.queryByText("Release the Steward?")).toBeNull());
    fireEvent.click(screen.getByText("Release"));
    expect((screen.getByLabelText(/Admin key/) as HTMLInputElement).value).toBe("");
    expect(api.stewardRelease).toHaveBeenCalledTimes(1);
  });
});
