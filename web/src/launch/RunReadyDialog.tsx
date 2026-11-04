import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { PanelCell } from "../core/types";
import { MAX_CELLS } from "./protocol";

type Row = Pick<PanelCell, "id" | "title" | "status">;

export interface RunReadyDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** all cells; only the ones with status ready are listed */
  cells: readonly Row[];
  /** called with the ticked ids (in list order) when Run is pressed; the dialog closes itself first */
  onRun(ids: string[]): void;
}

const secondary = {
  background: "var(--surface-2, #18213A)",
  border: "1px solid var(--raised-border, #2A3553)",
  borderRadius: 8,
  padding: "6px 12px",
  font: "600 12.5px var(--font-sans)",
} as const;

function Body({ ready, onRun }: { ready: Row[]; onRun: (ids: string[]) => void }) {
  const [sel, setSel] = useState<string[]>(() => ready.slice(0, MAX_CELLS).map((c) => c.id));
  // the list is live (polling): ignore ticked ids that are no longer ready
  const ticked = ready.filter((c) => sel.includes(c.id)).map((c) => c.id);
  const k = ticked.length;
  const full = k >= MAX_CELLS;

  const toggle = (id: string) => {
    if (ticked.includes(id)) setSel(ticked.filter((x) => x !== id));
    else if (!full) setSel([...ticked, id]);
  };

  return (
    <>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" style={secondary} onClick={() => setSel(ready.slice(0, MAX_CELLS).map((c) => c.id))}>
          Select all
        </button>
        <button type="button" style={secondary} onClick={() => setSel([])}>
          None
        </button>
        <span className="ml-auto" style={{ font: "500 12.5px var(--font-sans)", color: "var(--muted, #A9B2C6)" }}>
          {k} selected
        </span>
      </div>

      {ready.length === 0 ? (
        <p className="mt-3" style={{ font: "500 12.5px var(--font-sans)", color: "var(--muted, #A9B2C6)" }}>
          No cells are ready right now.
        </p>
      ) : (
        <ul className="mt-3 flex-1 overflow-y-auto" style={{ border: "1px solid var(--border, #1E2740)", borderRadius: 8 }}>
          {ready.map((c) => {
            const on = ticked.includes(c.id);
            return (
              <li key={c.id} style={{ borderTop: "1px solid var(--border, #1E2740)" }} className="first:border-t-0">
                <label className="flex cursor-pointer items-center gap-3" style={{ padding: "8px 12px" }}>
                  <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(c.id)} />
                  <span style={{ font: "600 12px var(--font-mono)", color: "var(--st-ready, #FFC857)" }}>{c.id}</span>
                  <span className="truncate" style={{ font: "500 13px var(--font-sans)" }}>
                    {c.title}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog.Description className="mt-3" style={{ font: "500 12px var(--font-sans)", color: "var(--muted-3, #8A93A8)" }}>
        The next window lets you pick the browser profiles.
      </Dialog.Description>

      <div className="mt-4 flex justify-end gap-2">
        <Dialog.Close style={secondary}>Cancel</Dialog.Close>
        <button
          type="button"
          disabled={k === 0}
          onClick={() => onRun(ticked)}
          style={{
            background: "var(--accent, #5B9DFF)",
            color: "#06142B",
            borderRadius: 8,
            padding: "6px 14px",
            font: "700 12.5px var(--font-sans)",
            opacity: k === 0 ? 0.5 : 1,
          }}
        >
          Run {k} cells
        </button>
      </div>
    </>
  );
}

/** Lists the ready cells with checkboxes and runs the ticked ones through launcher.startMany (via onRun). */
export default function RunReadyDialog({ open, onOpenChange, cells, onRun }: RunReadyDialogProps) {
  const ready = cells.filter((c) => c.status === "ready");
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl p-5 shadow-xl"
          style={{ background: "var(--surface, #0F1424)", border: "1px solid var(--border, #1E2740)", color: "var(--text, #E8ECF5)" }}
        >
          <Dialog.Title style={{ font: "700 16px var(--font-sans)" }}>Run ready cells</Dialog.Title>
          <Body
            ready={ready}
            onRun={(ids) => {
              onOpenChange(false);
              onRun(ids);
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
