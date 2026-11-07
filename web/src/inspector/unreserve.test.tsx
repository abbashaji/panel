import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelCell } from "../core/types";
import { CellDetails } from "./CellDetails";
import { ReleaseDialog, type AdminAction } from "./ReleaseDialog";

const h = vi.hoisted(() => ({
  release: vi.fn(),
  toast: vi.fn(),
  refresh: vi.fn(),
  clearReservation: null as null | (() => void),
  refreshAfterAction: vi.fn(),
}));

vi.mock("../core/api", () => ({
  ApiError: class ApiError extends Error {
    status = 0;
  },
  release: h.release,
  clearFeedback: vi.fn(),
  stewardRelease: vi.fn(),
}));

vi.mock("../core/store", () => ({
  usePanel: () => ({
    repo: "o/r",
    toast: h.toast,
    refresh: h.refresh,
    refreshAfterAction: h.refreshAfterAction,
    launcher: { owner: () => null, start: vi.fn(), open: vi.fn() },
  }),
}));

function makeCell(over: Partial<Record<string, unknown>> = {}): PanelCell {
  return {
    id: "C-072",
    title: "Some cell",
    status: "ready",
    critical: false,
    directDependents: 0,
    transitiveDependents: 0,
    allowedPaths: ["a.ts"],
    sha: { lock: null, tip: null },
    lastCommit: null,
    lease: null,
    attempts: 0,
    maxAttempts: 3,
    resumable: false,
    ...over,
  } as unknown as PanelCell;
}

/** CellDetails plus the dialog, like the inspector mounts them. refreshAfterAction drops the reservation, as the store does. */
function Harness({ initial }: { initial: PanelCell }) {
  const [cell, setCell] = useState(initial);
  const [dialog, setDialog] = useState<{ action: AdminAction; id: string } | null>(null);
  h.clearReservation = () => setCell((c) => ({ ...c, reservedBy: undefined }) as PanelCell);
  return (
    <>
      <CellDetails cell={cell} repo="o/r" onAdmin={(a) => setDialog({ action: a, id: cell.id })} />
      <ReleaseDialog action={dialog?.action ?? "release"} cellId={dialog?.id ?? null} onClose={() => setDialog(null)} />
    </>
  );
}

beforeEach(() => {
  h.release.mockReset();
  h.toast.mockReset();
  h.refresh.mockReset();
  h.refreshAfterAction.mockReset();
  h.refreshAfterAction.mockImplementation(() => {
    h.clearReservation?.();
    return Promise.resolve();
  });
  h.release.mockResolvedValue({ text: "Reservation cancelled.", cell: { status: "ready", resumable: false } });
});

afterEach(cleanup);

describe("Cancel reservation", () => {
  it("is offered only for a ready cell with reservedBy, and the holder line names the reserver", () => {
    render(<Harness initial={makeCell({ reservedBy: "Dana" })} />);
    expect(screen.getAllByRole("button", { name: "Cancel reservation" })).toHaveLength(1);
    expect(screen.getByText("Reserved by Dana")).toBeTruthy();
  });

  it("is not offered for a ready cell without a reservation", () => {
    render(<Harness initial={makeCell()} />);
    expect(screen.queryByRole("button", { name: "Cancel reservation" })).toBeNull();
    expect(screen.queryByText(/Reserved by/)).toBeNull();
  });

  it("is not offered for a cell that is not ready", () => {
    render(<Harness initial={makeCell({ status: "running", reservedBy: "Dana" })} />);
    expect(screen.queryByRole("button", { name: "Cancel reservation" })).toBeNull();
  });

  it("calls release once with the typed key and the name is gone after the answer", async () => {
    render(<Harness initial={makeCell({ reservedBy: "Dana" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
    fireEvent.change(screen.getByLabelText(/Admin key/), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Release C-072" }));

    await waitFor(() => expect(h.release).toHaveBeenCalledTimes(1));
    expect(h.release).toHaveBeenCalledWith("o/r", "C-072", "secret");
    await waitFor(() => expect(h.refreshAfterAction).toHaveBeenCalledTimes(1));
    expect(h.refreshAfterAction.mock.calls[0][0]).toBe("C-072");
    await waitFor(() => expect(screen.queryByText(/Reserved by/)).toBeNull());
    expect(screen.queryByRole("button", { name: "Cancel reservation" })).toBeNull();
  });
});
