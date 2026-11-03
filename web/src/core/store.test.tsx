import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { setMockMode } from "./api";
import { PanelProvider, usePanel } from "./store";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <PanelProvider>{children}</PanelProvider>
    </QueryClientProvider>
  );
}

describe("PanelProvider", () => {
  beforeEach(() => {
    setMockMode(true);
    window.localStorage.clear();
    window.localStorage.setItem("bp_repo", "demo/panel");
  });
  afterEach(() => setMockMode(false));

  it("loads the mock state and tracks selection, filters and view", async () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    await waitFor(() => expect(result.current.state).not.toBeNull());
    expect(result.current.state!.cells).toHaveLength(14);
    expect(result.current.needsLogin).toBe(false);

    act(() => result.current.select("C-004"));
    act(() => result.current.select("C-005", true));
    expect(result.current.selection).toEqual(["C-004", "C-005"]);
    act(() => result.current.clearSelection());
    expect(result.current.selection).toEqual([]);

    act(() => result.current.toggleStatusFilter("expired"));
    expect(result.current.statusFilter).toEqual(["expired"]);
    act(() => result.current.clearFilters());
    expect(result.current.statusFilter).toEqual([]);

    act(() => result.current.setView("table"));
    expect(result.current.view).toBe("table");
  });

  it("theme toggle sets data-theme on <html>", async () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    const before = result.current.theme;
    act(() => result.current.toggleTheme());
    expect(result.current.theme).not.toBe(before);
    expect(document.documentElement.dataset.theme).toBe(result.current.theme);
  });

  it("default launcher answers with a toast; a registered launcher replaces it", async () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    act(() => result.current.launcher.start("C-008"));
    expect(result.current.toasts.at(-1)?.msg).toMatch(/Launcher not installed/);

    const calls: string[] = [];
    let off = () => {};
    act(() => {
      off = result.current.registerLauncher({ start: (id) => void calls.push(id) });
    });
    act(() => result.current.launcher.start("C-008"));
    expect(calls).toEqual(["C-008"]);
    act(() => off());
    act(() => result.current.launcher.start("C-008"));
    expect(calls).toEqual(["C-008"]);
  });

  it("arrow-key move uses wave/id order", async () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => result.current.moveSelection(1));
    expect(result.current.selection).toEqual(["C-000"]);
  });
});
