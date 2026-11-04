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

describe("PanelProvider repo switching", () => {
  beforeEach(() => {
    setMockMode(true);
    window.localStorage.clear();
    window.localStorage.setItem("bp_repo", "demo/panel");
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => setMockMode(false));

  it("includes the current repo in recentRepos on first load", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    expect(result.current.recentRepos).toEqual(["demo/panel"]);
    expect(JSON.parse(window.localStorage.getItem("bp_repos")!)).toEqual(["demo/panel"]);
  });

  it("switchRepo accepts a valid repo, saves it, updates the URL and clears selection and filters", async () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    await waitFor(() => expect(result.current.state).not.toBeNull());
    act(() => result.current.select("C-004"));
    act(() => result.current.setSearch("api"));
    act(() => result.current.toggleStatusFilter("expired"));
    act(() => result.current.toggleHideMerged());

    let ok = false;
    act(() => {
      ok = result.current.switchRepo(" acme/web-app ");
    });
    expect(ok).toBe(true);
    expect(result.current.repo).toBe("acme/web-app");
    expect(result.current.recentRepos).toEqual(["acme/web-app", "demo/panel"]);
    expect(result.current.selection).toEqual([]);
    expect(result.current.search).toBe("");
    expect(result.current.statusFilter).toEqual([]);
    expect(result.current.hideMerged).toBe(false);
    expect(window.localStorage.getItem("bp_repo")).toBe("acme/web-app");
    expect(new URLSearchParams(window.location.search).get("repo")).toBe("acme/web-app");
  });

  it("switchRepo rejects invalid input and changes nothing", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    for (const bad of ["", "nope", "a/b/c", "a b/c", "/c", "a/", `${"x".repeat(101)}/y`]) {
      let ok = true;
      act(() => {
        ok = result.current.switchRepo(bad);
      });
      expect(ok).toBe(false);
    }
    expect(result.current.repo).toBe("demo/panel");
    expect(result.current.recentRepos).toEqual(["demo/panel"]);
    expect(window.location.search).toBe("");
  });

  it("moves a reused repo to the front and caps recents at 8", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    for (let i = 1; i <= 9; i++) act(() => void result.current.switchRepo(`o/r${i}`));
    expect(result.current.recentRepos).toHaveLength(8);
    expect(result.current.recentRepos[0]).toBe("o/r9");
    expect(result.current.recentRepos).not.toContain("demo/panel");
    act(() => void result.current.switchRepo("o/r5"));
    expect(result.current.recentRepos[0]).toBe("o/r5");
    expect(result.current.recentRepos).toHaveLength(8);
  });

  it("forgetRepo removes a repo from recents and storage", () => {
    const { result } = renderHook(() => usePanel(), { wrapper });
    act(() => void result.current.switchRepo("o/one"));
    act(() => result.current.forgetRepo("demo/panel"));
    expect(result.current.recentRepos).toEqual(["o/one"]);
    expect(JSON.parse(window.localStorage.getItem("bp_repos")!)).toEqual(["o/one"]);
  });
});
