import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { StatusIcon } from "../core/Icon";
import { STATUS_META } from "../core/status";
import { usePanel } from "../core/store";

const LABELS: Record<string, string> = {
  done: "Merged",
  running: "Running",
  ready: "Ready",
  waiting: "Waiting",
  expired: "Lease expired",
  needs_human: "Needs human",
  needs_split: "Needs split",
};

const labelOf = (status: string) => LABELS[status] ?? status;

/** Search dialog (Ctrl+K): lists every cell in a scroll view; typing filters live, Enter or click selects. */
export default function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { state, select } = usePanel();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  const all = useMemo(
    () =>
      [...(state?.cells ?? [])].sort((a, b) => a.wave - b.wave || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [state],
  );

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (c) =>
        c.id.toLowerCase().includes(needle) ||
        c.title.toLowerCase().includes(needle) ||
        labelOf(c.status).toLowerCase().includes(needle),
    );
  }, [all, q]);

  const active = results.length ? Math.min(idx, results.length - 1) : -1;
  const activeId = active >= 0 ? results[active].id : undefined;

  useEffect(() => {
    if (!open || !activeId) return;
    const el = document.getElementById(`palette-${activeId}`);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [open, activeId]);

  const pick = (id: string) => {
    select(id);
    onOpenChange(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx(Math.max(0, Math.min(active + 1, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx(Math.max(0, active - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setIdx(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      const c = results[active];
      if (c) {
        e.preventDefault();
        pick(c.id);
      }
    }
  };

  const filtering = q.trim() !== "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40" style={{ background: "rgba(0,0,0,0.5)" }} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-24 z-50 w-[min(560px,92vw)] -translate-x-1/2 rounded-lg border shadow-xl"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
        >
          <Dialog.Title className="sr-only">Search cells</Dialog.Title>
          <input
            role="combobox"
            aria-label="Search cells"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={activeId ? `palette-${activeId}` : undefined}
            placeholder="Search by id, title or status…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
            className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
          <div className="px-4 py-1.5 text-xs" style={{ color: "var(--muted)" }} data-testid="palette-count">
            {filtering ? `${results.length} of ${all.length}` : `${all.length} cells`}
          </div>
          <ul
            id="palette-list"
            role="listbox"
            aria-label="Matching cells"
            className="p-1"
            style={{ maxHeight: "60vh", overflowY: "auto" }}
          >
            {results.length === 0 && (
              <li className="px-3 py-2 text-sm" style={{ color: "var(--muted)" }}>
                No matching cells
              </li>
            )}
            {results.map((c, i) => (
              <li
                key={c.id}
                id={`palette-${c.id}`}
                role="option"
                aria-selected={i === active}
                onClick={() => pick(c.id)}
                onMouseEnter={() => setIdx(i)}
                className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm"
                style={{ background: i === active ? "var(--surface-2)" : "transparent" }}
              >
                <span className="mono">{c.id}</span>
                <span className="flex-1 truncate">{c.title}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  Wave {c.wave}
                </span>
                <span
                  className="inline-flex items-center gap-1 text-xs font-semibold"
                  style={{ color: STATUS_META[c.status].color }}
                >
                  <StatusIcon status={c.status} />
                  {labelOf(c.status)}
                </span>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
