import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, clearFeedback, getState, isMock, release, reserve, setMockMode } from "./api";
import { resetMock } from "./mock";

describe("mock mode", () => {
  beforeEach(() => {
    setMockMode(true);
    resetMock();
  });
  afterEach(() => setMockMode(false));

  it("returns 14 cells with consistent counts and an expired bottleneck", async () => {
    const s = await getState("o/r");
    expect(s.repo).toBe("o/r");
    expect(s.cells).toHaveLength(14);
    const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(14);
    expect(s.counts.expired).toBe(1);
    expect(s.bottleneck?.id).toBe("C-004");
    const b = s.cells.find((c) => c.id === s.bottleneck!.id)!;
    expect(b.status).toBe("expired");
    expect(b.critical).toBe(true);
    expect(b.transitiveDependents).toBe(s.bottleneck!.blocks);
  });

  it("waiting cells are blocked only by unfinished implementation deps", async () => {
    const s = await getState("o/r");
    const c6 = s.cells.find((c) => c.id === "C-006")!;
    expect(c6.blockedBy).toEqual(["C-004", "C-005"]);
    expect(c6.depends.find((d) => d.id === "C-003")?.kind).toBe("contract");
  });

  it("reserve: ready ok, waiting not_ready, other person's reservation taken", async () => {
    expect((await reserve("o/r", "C-008", "Sara")).status).toBe("reserved");
    expect((await reserve("o/r", "C-008", "Omar")).status).toBe("taken");
    expect((await reserve("o/r", "C-005", "Sara")).status).toBe("not_ready");
  });

  it("admin actions answer with text", async () => {
    expect(await release("o/r", "C-004", "key")).toContain("C-004");
    expect(await clearFeedback("o/r", "C-004", "key")).toContain("C-004");
  });
});

describe("real API", () => {
  beforeEach(() => setMockMode(false));
  afterEach(() => vi.unstubAllGlobals());

  it("sends same-origin credentials and the encoded repo", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ repo: "a/b", cells: [] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await getState("a/b");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/panel/api/state?repo=a%2Fb");
    expect(init.credentials).toBe("same-origin");
  });

  it("401 becomes an ApiError with status 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const err = await getState("a/b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(isMock()).toBe(false);
  });

  it("release posts the admin key in the body and passes the text through (max 200 chars)", async () => {
    const f = vi.fn(async () => new Response("x".repeat(500), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const out = await release("a/b", "C-004", "secret");
    expect(out).toHaveLength(200);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ repo: "a/b", cell_id: "C-004", admin_key: "secret" });
  });
});
