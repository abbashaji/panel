// longpoll.ts
//
// next_cell with a bounded server-side wait, so an idle chat picks up work without a human re-prompt.

import type { GitHubApi } from "./api.ts";
import type { EngineOptions } from "./common.ts";
import { nextCell } from "./claim.ts";

export const MAX_WAIT_SECONDS = 60;
export const POLL_INTERVAL_MS = 10_000;
// Free Workers plan: ~50 subrequests per invocation, one nextCell costs about 3-4. This cap is the guard.
export const MAX_POLLS = 6;
const RETRY_AFTER_SECONDS = 45;

export async function nextCellWait(api: GitHubApi, repo: string, opts: EngineOptions, waitSeconds: number): Promise<string> {
  const w = Number.isFinite(waitSeconds) ? Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) : 0;
  const start = opts.now();
  let text = await nextCell(api, repo, opts, "claim");
  if (w <= 0) return text;

  const deadline = start + w * 1000;
  let polls = 1;
  while (text.startsWith("NONE_READY") && polls < MAX_POLLS) {
    const remaining = deadline - opts.now();
    if (remaining <= 0) break;
    await opts.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    text = await nextCell(api, repo, opts, "claim");
    polls++;
  }
  if (!text.startsWith("NONE_READY")) return text;

  // Running cells look like C-007(12m); the CI form C-007(CI<=30m) does not match.
  const mins = [...text.matchAll(/\bC-\d+\((\d+)m\)/g)].map((m) => Number(m[1]));
  const expiry = mins.length ? ` (next lease expiry in ~${Math.min(...mins)} min)` : "";
  return `${text}\nretry_after=${RETRY_AFTER_SECONDS}${expiry}`;
}
