import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RULES } from "../src/protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const skip = existsSync(join(here, "../../blueprint-kit/docs/contracts.md")) ? false : "sibling folder blueprint-kit not present";
const LIMIT_WARNING_TEXT =
  "LIMIT_WARNING: this account is over 90% of its usage cap. Start no new work. Commit the current file group; if the cell is complete call submit_cell, else call cell_signal release with next: and end your turn. Do not call next_cell again in this chat.";

test("RULES has the LIMIT_WARNING rule, one line of at most 40 words", () => {
  const line = RULES.split("\n").find((l) => l.includes("LIMIT_WARNING"));
  assert.ok(line, "rule missing");
  assert.match(line!, /cell_signal release/);
  assert.match(line!, /Never call next_cell again/);
  assert.ok(line!.replace(/^- /, "").split(/\s+/).length <= 40);
});

test("contracts.md holds C5 and the exact LIMIT_WARNING_TEXT", { skip }, () => {
  const c = readFileSync(join(here, "../../blueprint-kit/docs/contracts.md"), "utf-8");
  assert.ok(c.includes("## C5 usage warning"));
  assert.ok(c.includes("/ext/warn"));
  assert.ok(c.includes("warn:<repo>:<cell_id>"));
  assert.ok(c.includes(LIMIT_WARNING_TEXT));
  assert.ok(c.includes("acct.warnAt") || c.includes("warnAt"));
  assert.ok(c.includes('{type:"warn", chat, text}'));
});

test("BLUEPRINT.md mentions LIMIT_WARNING", { skip }, () => {
  const b = readFileSync(join(here, "../../blueprint-kit/BLUEPRINT.md"), "utf-8");
  assert.ok(b.includes("LIMIT_WARNING"));
});
