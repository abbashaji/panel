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
    expect(out.text).toHaveLength(200);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ repo: "a/b", cell_id: "C-004", admin_key: "secret" });
  });
});


// ---- C-031: action answers carry the new cell state ----
import { afterEach as c031After, beforeEach as c031Before, describe as c031Describe, expect as c031Expect, it as c031It, vi as c031Vi } from "vitest";
import { clearFeedback as c031Clear, isMock as c031IsMock, release as c031Release, reserve as c031Reserve, setMockMode as c031SetMock } from "./api";

c031Describe("action answers (C-031)", () => {
  const wasMock = c031IsMock();
  const answer = (body: unknown) => c031Vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 }));
  c031Before(() => c031SetMock(false));
  c031After(() => {
    c031Vi.unstubAllGlobals();
    c031SetMock(wasMock);
  });

  c031It("release returns text and the parsed cell", async () => {
    c031Vi.stubGlobal("fetch", answer({ result: "Released. Ready to resume.", cell: { id: "C-031", status: "ready", resumable: true } }));
    const r = await c031Release("a/b", "C-031", "k");
    c031Expect(r.text).toBe("Released. Ready to resume.");
    c031Expect(r.cell).toEqual({ id: "C-031", status: "ready", resumable: true });
  });

  c031It("clearFeedback parses the cell and defaults resumable to false", async () => {
    c031Vi.stubGlobal("fetch", answer({ result: "Feedback cleared.", cell: { id: "C-031", status: "ready" } }));
    const r = await c031Clear("a/b", "C-031", "k");
    c031Expect(r.text).toBe("Feedback cleared.");
    c031Expect(r.cell).toEqual({ id: "C-031", status: "ready", resumable: false });
  });

  c031It("an older Worker without a cell field still works (JSON and plain text)", async () => {
    c031Vi.stubGlobal("fetch", answer({ result: "ok" }));
    const a = await c031Release("a/b", "C-031", "k");
    c031Expect(a.text).toBe("ok");
    c031Expect(a.cell).toBeUndefined();
    c031Vi.stubGlobal("fetch", answer("plain words"));
    const b = await c031Clear("a/b", "C-031", "k");
    c031Expect(b.text).toBe("plain words");
    c031Expect(b.cell).toBeUndefined();
  });

  c031It("reserve keeps its fields and adds the cell", async () => {
    c031Vi.stubGlobal("fetch", answer({ ok: true, cell: { id: "C-031", status: "reserved", resumable: false } }));
    const r = await c031Reserve("a/b", "C-031", "me");
    c031Expect((r as { ok?: boolean }).ok).toBe(true);
    c031Expect(r.cell?.status).toBe("reserved");
  });

  c031It("the answer text never contains the admin key", async () => {
    const f = answer({ result: "Released.", cell: { id: "C-031", status: "ready", resumable: true } });
    c031Vi.stubGlobal("fetch", f);
    const r = await c031Release("a/b", "C-031", "sekret-key");
    c031Expect(JSON.stringify(r)).not.toContain("sekret-key");
  });
});
