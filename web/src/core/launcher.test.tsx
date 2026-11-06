import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelProvider, usePanel, type PanelContextValue } from "./store";

let panel: PanelContextValue | null = null;

function Probe({ fn }: { fn?: () => void }) {
  const p = usePanel();
  panel = p;
  const { registerLauncher } = p;
  useEffect(() => (fn ? registerLauncher({ startSteward: fn }) : undefined), [fn, registerLauncher]);
  return <ul>{p.toasts.map((t) => <li key={t.id}>{t.msg}</li>)}</ul>;
}

function mount(fn?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PanelProvider>
        <Probe fn={fn} />
      </PanelProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  panel = null;
});

describe("usePanel().launcher.startSteward", () => {
  it("calls the registered startSteward", () => {
    const fn = vi.fn();
    mount(fn);
    act(() => panel!.launcher.startSteward!());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("shows the 'Launcher not installed' toast without registration and does not throw", () => {
    const { container } = mount();
    expect(typeof panel!.launcher.startSteward).toBe("function");
    expect(() => act(() => panel!.launcher.startSteward!())).not.toThrow();
    expect(container.textContent).toContain("Launcher not installed");
  });
});
