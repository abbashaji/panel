import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Cross-package contract checks. Skipped (not failed) when the sibling folders are absent.
const here = dirname(fileURLToPath(import.meta.url));
const contractsPath = join(here, "../../blueprint-kit/docs/contracts.md");
const contentPath = join(here, "../../blueprint-limit-ext/content.js");
const echoPath = join(here, "protocol_echo.test.ts");
const extPath = join(here, "../src/ext.ts");
const siblings = existsSync(contractsPath) && existsSync(contentPath);
const skip = siblings ? false : "sibling folders blueprint-kit / blueprint-limit-ext not present";

// The C1 literal as written in source text: /\b(CLAIMED|RESUME) ... repo=(...)/g (ends at the first ")/g").
const C1_LITERAL = /\/\\b\(CLAIMED\|RESUME\).*?\)\/g/g;

function literals(path: string): string[] {
  return readFileSync(path, "utf-8").match(C1_LITERAL) ?? [];
}

test("C1 regex literal is identical in content.js, contracts.md and protocol_echo.test.ts", { skip }, () => {
  const found = {
    "content.js": literals(contentPath),
    "contracts.md": literals(contractsPath),
    "protocol_echo.test.ts": literals(echoPath),
  };
  for (const [name, list] of Object.entries(found)) assert.ok(list.length >= 1, `no C1 literal found in ${name}`);
  const reference = found["contracts.md"][0];
  assert.ok(reference.includes("CLAIMED|RESUME") && reference.includes("base=") && reference.includes("repo="), "reference literal looks wrong");
  for (const [name, list] of Object.entries(found)) {
    for (const lit of list) assert.equal(lit, reference, `C1 literal in ${name} differs from contracts.md`);
  }
});

test("C2 release subject prefix and text agree between ext.ts and contracts.md", { skip }, () => {
  const ext = readFileSync(extPath, "utf-8");
  const doc = readFileSync(contractsPath, "utf-8");
  // Worker side: the subject template; doc side: the documented subject.
  assert.ok(ext.includes("`release(${id}): usage limit"), "ext.ts no longer builds `release(<id>): usage limit`");
  assert.ok(doc.includes("`release(C-NNN): usage limit`"), "contracts.md no longer documents `release(C-NNN): usage limit`");
  for (const [name, text] of [["ext.ts", ext], ["contracts.md", doc]] as const) {
    assert.ok(text.includes("release("), `${name} lacks the release( prefix`);
    assert.ok(text.includes("usage limit"), `${name} lacks the text "usage limit"`);
  }
});
