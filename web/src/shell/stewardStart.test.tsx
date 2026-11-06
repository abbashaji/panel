import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelProvider, usePanel } from "../core/store";
import StewardChip from "./StewardChip";

vi.mock("../core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/api")>();
  return {
    ...actual,
    getState: vi.fn(async () => ({
      cells: [],
      steward: { status: "none", holder: null, minutesLeft: null, expiredMinutesAgo: null, problems: 2 },
    })),
  };
});

function Register({ fn }: { fn: () => void }) {
  const { registerLauncher } = usePanel();
  useEffect(() => registerLauncher({ startSteward: fn }), [fn, registerLauncher]);
  return null;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/?repo=owner/name");
});

afterEach(() => {
  cleanup();
});

describe("StewardChip with the real PanelProvider", () => {
  it("shows Start steward when status is none and a click calls the registered startSteward", async () => {
    const fn = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PanelProvider>
          <Register fn={fn} />
          <StewardChip />
        </PanelProvider>
      </QueryClientProvider>,
    );
    const button = await waitFor(() => screen.getByRole("button", { name: "Start steward" }));
    act(() => {
      fireEvent.click(button);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
