// Integration: every feature slot (shell, graph, table, inspector, launch) is built and rendered by App with the mock data.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import App from "./App";
import { setMockMode } from "./core/api";
import { resetMock } from "./core/mock";
import { PanelProvider } from "./core/store";
import * as graph from "./graph";
import * as inspector from "./inspector";
import * as launch from "./launch";
import * as shell from "./shell";
import * as table from "./table";

// jsdom lacks what React Flow measures with.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver ??= RO;
(globalThis as any).DOMMatrixReadOnly ??= class {
  m22 = 1;
  constructor(_t?: string) {}
};

function withClient(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("panel slots", () => {
  beforeEach(() => {
    setMockMode(true);
    resetMock();
    window.localStorage.clear();
    window.localStorage.setItem("bp_repo", "demo/panel");
  });
  afterEach(() => {
    cleanup();
    setMockMode(false);
  });

  it("every slot module exports its component", () => {
    expect(typeof shell.default).toBe("function");
    expect(typeof graph.default).toBe("function");
    expect(typeof table.default).toBe("function");
    expect(table.TimelineView).toBeDefined();
    expect(typeof inspector.default).toBe("function");
    expect(typeof launch.default).toBe("function");
  });

  it("App renders the shell, graph and inspector with no placeholder left", async () => {
    const { container } = render(withClient(<App />));
    await waitFor(() => expect(screen.getAllByText("C-004").length).toBeGreaterThan(0));
    expect(container.querySelector(".react-flow")).not.toBeNull();
    expect(screen.queryAllByLabelText("Inspector").length).toBeGreaterThan(0);
    expect(screen.queryByText(/not built yet/)).toBeNull();
  });

  it("the table slot lists the cells", async () => {
    render(
      withClient(
        <PanelProvider>
          <table.default />
        </PanelProvider>,
      ),
    );
    await waitFor(() => expect(screen.getAllByText("C-004").length).toBeGreaterThan(0));
    expect(screen.getAllByText("C-011").length).toBeGreaterThan(0);
  });
});
