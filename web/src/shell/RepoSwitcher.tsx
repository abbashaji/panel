import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { usePanel } from "../core/store";

const raised = { background: "var(--surface-2)", border: "1px solid var(--raised-border)", borderRadius: 8 } as const;

function Glyph({ d, size, label }: { d: string; size: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={d} />
    </svg>
  );
}

export default function RepoSwitcher() {
  const { repo, state, recentRepos, switchRepo, forgetRepo } = usePanel();
  const current = repo || state?.repo || "";
  const recents = recentRepos ?? [];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) {
      setDraft("");
      setError("");
    }
  };
  const go = (value: string) => {
    if (switchRepo(value)) {
      setOpen(false);
      setError("");
    } else {
      setError("Enter a repository as owner/name, for example acme/panel.");
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Switch repository"
          className="mono flex min-w-0 items-center gap-1.5"
          style={{ ...raised, font: "500 12px var(--font-mono)", padding: "6px 10px", color: "#c6cddd" }}
        >
          <span className="truncate">{current ? `${current} · main` : "Choose repository"}</span>
          <Glyph d="M3.5 5.5L7 9l3.5-3.5" size={10} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          aria-label="Switch repository"
          style={{
            zIndex: 50,
            width: 320,
            padding: 12,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 12px 32px rgba(0,0,0,.45)",
            color: "var(--text)",
          }}
        >
          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  go(draft);
                }
              }}
              aria-label="Repository (owner/name)"
              placeholder="owner/name"
              spellCheck={false}
              autoComplete="off"
              className="mono min-w-0 flex-1"
              style={{ ...raised, height: 34, padding: "0 10px", font: "500 12.5px var(--font-mono)", color: "var(--text)" }}
            />
            <button
              type="button"
              onClick={() => go(draft)}
              style={{ height: 34, padding: "0 14px", borderRadius: 8, background: "var(--accent)", color: "#06142b", font: "700 12.5px var(--font-sans)" }}
            >
              Open
            </button>
          </div>
          {error && (
            <p role="alert" style={{ margin: "8px 0 0", font: "500 12px var(--font-sans)", color: "#ffb4ab" }}>
              {error}
            </p>
          )}
          {recents.length > 0 && (
            <>
              <p style={{ margin: "14px 0 6px", font: "600 11px var(--font-sans)", letterSpacing: ".08em", color: "var(--muted-3)" }}>RECENT</p>
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {recents.map((r) => (
                  <li key={r} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => go(r)}
                      className="mono flex min-w-0 flex-1 items-center gap-2 text-left"
                      style={{ padding: "7px 8px", borderRadius: 8, font: "500 12.5px var(--font-mono)", color: "#d5dbe8" }}
                    >
                      <span style={{ width: 12, display: "inline-flex", color: "var(--st-done)" }}>
                        {r === current && <Glyph d="M3 7.5l3 3 5-6" size={12} label="Current repository" />}
                      </span>
                      <span className="truncate">{r}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => forgetRepo(r)}
                      aria-label={`Remove ${r} from recent`}
                      style={{ padding: 6, borderRadius: 8, color: "var(--muted-2)" }}
                    >
                      <Glyph d="M3.5 3.5l7 7M10.5 3.5l-7 7" size={10} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
