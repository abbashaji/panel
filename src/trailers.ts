// trailers.ts
//
// Commit-message trailers carried forward from the previous branch tip. Pure: no imports.
// "attempt:" is written only when n > 0 (missing = 0, so old branches stay valid). The last occurrence of a trailer wins.

export interface Trailers {
  next?: string;
  attempt: number;
  req?: string;
}

/** First line of a commit message, trimmed. */
export function subjectOf(message: string): string {
  return (message.split("\n", 1)[0] ?? "").trim();
}

export function parseTrailers(message: string): Trailers {
  const t: Trailers = { attempt: 0 };
  for (const raw of message.split("\n").slice(1)) {
    const m = /^(next|attempt|req):[ \t]*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === "next") t.next = v;
    else if (m[1] === "req") t.req = v;
    else t.attempt = /^\d+$/.test(v) ? Number(v) : 0;
  }
  return t;
}

export function formatMessage(subject: string, t: { next?: string; attempt?: number; req?: string }): string {
  const lines: string[] = [];
  if (t.next) lines.push(`next: ${t.next}`);
  if (t.attempt !== undefined && t.attempt > 0) lines.push(`attempt: ${t.attempt}`);
  if (t.req) lines.push(`req: ${t.req}`);
  return lines.length ? `${subject}\n\n${lines.join("\n")}` : subject;
}

/** New message: next and attempt copied from prev unless overridden; req is never copied. */
export function carry(prev: string, subject: string, over: { next?: string; attempt?: number; req?: string | null } = {}): string {
  const p = parseTrailers(prev);
  return formatMessage(subject, { next: over.next ?? p.next, attempt: over.attempt ?? p.attempt, req: over.req ?? undefined });
}

export function isRelease(message: string): boolean {
  return stateSubject(message).startsWith("release(");
}

export function isFeedback(message: string): boolean {
  return stateSubject(message).startsWith("feedback(");
}

// ---- Steward (see steward.ts). A note on a cell branch is an empty commit "steward(C-NNN): text". It keeps the
// release / feedback state of the commit it was written on in a "held:" trailer, so a note never hides a feedback.
export function isSteward(message: string): boolean {
  return subjectOf(message).startsWith("steward(");
}

/** The text of a steward note commit, or null if the message is not one (the lease commit steward(lease) is not a note). */
export function stewardNote(message: string): string | null {
  const m = /^steward\((C-\d{3,})\):[ \t]*(.*)$/.exec(subjectOf(message));
  return m && m[2] ? m[2] : null;
}

function heldOf(message: string): string {
  let held = "";
  for (const raw of message.split("\n").slice(1)) {
    const m = /^held:[ \t]*(.*)$/.exec(raw.trim());
    if (m) held = m[1].trim();
  }
  return held;
}

/** The subject that decides release / feedback state: a steward note stands in for the commit it was written on. */
export function stateSubject(message: string): string {
  const s = subjectOf(message);
  return isSteward(s) ? heldOf(message) || s : s;
}

export function withHeld(message: string, held: string | undefined): string {
  if (!held) return message;
  return message.includes("\n") ? `${message}\nheld: ${held}` : `${message}\n\nheld: ${held}`;
}
