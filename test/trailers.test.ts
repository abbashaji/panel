import { test } from "node:test";
import assert from "node:assert/strict";

import { carry, formatMessage, isFeedback, isRelease, parseTrailers, subjectOf } from "../src/trailers.ts";

test("subjectOf takes the trimmed first line", () => {
  assert.equal(subjectOf("  WIP: x  \n\nnext: y"), "WIP: x");
  assert.equal(subjectOf(""), "");
});

test("format and parse round trip", () => {
  const m = formatMessage("WIP: a", { next: "do b", attempt: 2, req: "abc" });
  assert.equal(m, "WIP: a\n\nnext: do b\nattempt: 2\nreq: abc");
  assert.deepEqual(parseTrailers(m), { next: "do b", attempt: 2, req: "abc" });
});

test("attempt is omitted at 0 and nothing trails the message", () => {
  assert.equal(formatMessage("s", { next: "n", attempt: 0 }), "s\n\nnext: n");
  assert.equal(formatMessage("s", {}), "s");
});

test("last occurrence wins", () => {
  const t = parseTrailers("s\n\nnext: a\nattempt: 1\nnext: b\nattempt: 3\nreq: x\nreq: y");
  assert.deepEqual(t, { next: "b", attempt: 3, req: "y" });
});

test("attempt missing or garbage parses as 0", () => {
  assert.equal(parseTrailers("s\n\nnext: n").attempt, 0);
  assert.equal(parseTrailers("s\n\nattempt: lots").attempt, 0);
  assert.equal(parseTrailers("s\n\nattempt: -2").attempt, 0);
  assert.equal(parseTrailers("s\n\nattempt: 2\nattempt: oops").attempt, 0);
});

test("carry keeps next and attempt, drops req", () => {
  const prev = formatMessage("WIP: a", { next: "n1", attempt: 2, req: "r1" });
  assert.equal(carry(prev, "S"), "S\n\nnext: n1\nattempt: 2");
  assert.equal(carry(prev, "S", { next: "n2", attempt: 0 }), "S\n\nnext: n2");
  assert.equal(carry(prev, "S", { req: "r2" }), "S\n\nnext: n1\nattempt: 2\nreq: r2");
  assert.equal(carry(prev, "S", { req: null }), "S\n\nnext: n1\nattempt: 2");
});

test("isRelease and isFeedback look at the subject", () => {
  assert.ok(isRelease("release(C-001): x"));
  assert.ok(!isRelease("WIP: release(C-001)"));
  assert.ok(isFeedback("feedback(C-001): x\n\nnext: y"));
  assert.ok(!isFeedback("release(C-001)"));
});

test("an old-style message parses to next y, attempt 0", () => {
  assert.deepEqual(parseTrailers("WIP: x\n\nnext: y"), { next: "y", attempt: 0 });
});
