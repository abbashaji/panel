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
  return subjectOf(message).startsWith("release(");
}

export function isFeedback(message: string): boolean {
  return subjectOf(message).startsWith("feedback(");
}
