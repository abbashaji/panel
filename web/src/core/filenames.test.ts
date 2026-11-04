import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { expect, it } from "vitest";

// Windows and macOS ignore letter case in file names, so Activity.tsx and activity.ts clash there
// even though Linux CI is happy. Fail when two source files in one folder share a name stem.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

it("no two source files in a folder share a name stem ignoring case", () => {
  const root = resolve(process.cwd(), "src"); // tests run from web/ (npm --prefix web test)
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const f of walk(root).filter((x) => /\.tsx?$/.test(x))) {
    const key = join(dirname(f), basename(f, extname(f))).toLowerCase();
    const other = seen.get(key);
    if (other) clashes.push(`${other} <-> ${f}`);
    else seen.set(key, f);
  }
  expect(clashes).toEqual([]);
});
