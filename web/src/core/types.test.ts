import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// web/src/core/types.ts mirrors src/panel/types.ts. Fail when an exported name or a field of the shared
// state types drifts apart.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

const exported = (src: string) => [...src.matchAll(/export (?:type|interface) (\w+)/g)].map((m) => m[1]);

function fields(src: string, iface: string): string[] {
  const m = src.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`));
  return m ? [...m[1].matchAll(/^  (\w+)\??:/gm)].map((x) => x[1]).sort() : [];
}

describe("web types mirror the Worker types", () => {
  const worker = read("../../../src/panel/types.ts");
  const web = read("./types.ts");

  it("every shared type name exists in both files", () => {
    const w = new Set(exported(web));
    for (const name of exported(worker)) {
      if (["PanelEnv", "LoginBody", "ReserveBody", "AdminActionBody"].includes(name)) continue; // Worker only
      expect(w.has(name), `${name} missing in web/src/core/types.ts`).toBe(true);
    }
  });

  it.each(["PanelCell", "PanelState", "PanelCounts", "ReserveResult", "PanelDepend"])("%s has the same fields", (name) => {
    expect(fields(web, name)).toEqual(fields(worker, name));
    expect(fields(web, name).length).toBeGreaterThan(0);
  });

  it("status union is identical", () => {
    const union = (s: string) => [...(s.match(/export type PanelStatus =([^;]*);/)?.[1].matchAll(/"(\w+)"/g) ?? [])].map((m) => m[1]).sort();
    expect(union(web)).toEqual(union(worker));
    expect(union(web)).toHaveLength(7);
  });
});
