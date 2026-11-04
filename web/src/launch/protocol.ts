// blueprint:// URL builders (docs/panel-contracts.md section 4). The launcher treats every URL as hostile, so the panel
// builds only URLs that already pass the launcher's validation and refuses everything else.

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const CELL_RE = /^C-\d{3,5}$/;
export const WHO_RE = /^[\w .-]{1,40}$/;
export const MAX_URL = 400;
/** most cells one startmany link may carry */
export const MAX_CELLS = 12;

const enc = encodeURIComponent;

function need(re: RegExp, value: unknown, name: string): string {
  if (typeof value !== "string" || !re.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

function fit(url: string): string {
  if (url.length > MAX_URL) throw new Error("launcher link too long");
  return url;
}

/** blueprint://start?repo=&cell=&who=  (only repo, cell id and display name leave the panel) */
export function startUrl(repo: string, cell: string, who: string): string {
  need(REPO_RE, repo, "repo");
  need(CELL_RE, cell, "cell");
  need(WHO_RE, who, "name");
  return fit(`blueprint://start?repo=${enc(repo)}&cell=${enc(cell)}&who=${enc(who)}`);
}

/**
 * blueprint://startmany?repo=&who=&cells=C-001,C-002  (1 to 12 valid, unique cell ids; same checks as startUrl).
 * Throws when anything is invalid or the whole link passes 400 characters.
 */
export function startManyUrl(repo: string, who: string, cells: readonly string[]): string {
  need(REPO_RE, repo, "repo");
  need(WHO_RE, who, "name");
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > MAX_CELLS) throw new Error(`need 1 to ${MAX_CELLS} cells`);
  for (const id of cells) need(CELL_RE, id, "cell");
  if (new Set(cells).size !== cells.length) throw new Error("duplicate cell");
  return fit(`blueprint://startmany?repo=${enc(repo)}&who=${enc(who)}&cells=${cells.join(",")}`);
}

/** blueprint://open?repo=&cell= */
export function openUrl(repo: string, cell: string): string {
  need(REPO_RE, repo, "repo");
  need(CELL_RE, cell, "cell");
  return fit(`blueprint://open?repo=${enc(repo)}&cell=${enc(cell)}`);
}

/**
 * blueprint://sync?repo=&merged=C-001,C-002. Invalid ids are dropped, duplicates removed. When the list would pass
 * the 400 character limit the highest ids are kept. Throws when no valid id is left.
 */
export function syncUrl(repo: string, merged: readonly string[]): string {
  need(REPO_RE, repo, "repo");
  const ids = [...new Set(merged.filter((id) => typeof id === "string" && CELL_RE.test(id)))].sort().reverse();
  const head = `blueprint://sync?repo=${enc(repo)}&merged=`;
  const kept: string[] = [];
  let len = head.length;
  for (const id of ids) {
    const add = id.length + (kept.length ? 1 : 0);
    if (len + add > MAX_URL) break;
    kept.push(id);
    len += add;
  }
  if (kept.length === 0) throw new Error("no merged cells to sync");
  return head + kept.join(",");
}

/** The only code that touches the browser. Tests replace these. */
export const transport = {
  /** open a blueprint:// link (call from a click) */
  go(url: string): void {
    window.location.href = url;
  },
  /** fire a blueprint:// link without leaving the page (hidden iframe) */
  silent(url: string): void {
    const f = document.createElement("iframe");
    f.style.display = "none";
    f.setAttribute("aria-hidden", "true");
    f.src = url;
    document.body.appendChild(f);
    window.setTimeout(() => f.remove(), 2000);
  },
  /** after `go`: call onMissing when the page is still visible after `ms` (launcher probably not installed) */
  watch(onMissing: () => void, ms = 2000): void {
    let left = false;
    const gone = () => {
      left = true;
    };
    const changed = () => {
      if (document.visibilityState !== "visible") left = true;
    };
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("pagehide", gone);
    window.setTimeout(() => {
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("pagehide", gone);
      if (!left && document.visibilityState === "visible") onMissing();
    }, ms);
  },
};
