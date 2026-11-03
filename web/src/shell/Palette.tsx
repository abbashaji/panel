import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { usePanel } from "../core/store";
import { matchesSearch } from "./filter";
import { StatusBadge } from "./StatusBadge";

/** Ctrl+K palette: type to find a cell, Enter or click selects it. */
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

  const results = useMemo(() => (state?.cells ?? []).filter((c) => matchesSearch(c, q)).slice(0, 8), [state, q]);

  const pick = (id: string) => {
    select(id);
    onOpenChange(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.max(0, Math.min(i + 1, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const c = results[idx];
      if (c) {
        e.preventDefault();
        pick(c.id);
      }
    }
  };

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
            aria-activedescendant={results[idx] ? `palette-${results[idx].id}` : undefined}
            placeholder="Search by id or title…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
            className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
            style={{ borderColor: "var(--border)" }}
          />
          <ul id="palette-list" role="listbox" aria-label="Matching cells" className="max-h-72 overflow-y-auto p-1">
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
                aria-selected={i === idx}
                onClick={() => pick(c.id)}
                onMouseEnter={() => setIdx(i)}
                className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm"
                style={{ background: i === idx ? "var(--surface-2)" : "transparent" }}
              >
                <span className="mono">{c.id}</span>
                <span className="flex-1 truncate">{c.title}</span>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
