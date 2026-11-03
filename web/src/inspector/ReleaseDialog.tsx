import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, clearFeedback, release } from "../core/api";
import { usePanel } from "../core/store";

export type AdminAction = "release" | "clear-feedback";

/** The exact git write each admin action performs. Shown in the confirm step before anything is sent. */
export function gitWriteText(action: AdminAction, cellId: string): string {
  if (action === "release") {
    return `This writes ONE empty commit to branch cell/${cellId} (a hand-over takeover). No files change and nothing is deleted; the cell becomes free for the next chat to claim.`;
  }
  return `This changes the branch state of cell/${cellId}: it clears the recorded feedback so the cell can be claimed again (a takeover with clear_feedback). No files change.`;
}

export interface ReleaseDialogProps {
  action: AdminAction;
  /** the dialog is open while this is set */
  cellId: string | null;
  onClose(): void;
}

const field =
  "w-full rounded border border-white/20 bg-transparent px-2 py-1 text-sm text-inherit";
const btn = "rounded border border-white/20 px-3 py-1 text-sm disabled:opacity-40";

/** Confirm dialog for Release / Clear feedback. The admin key lives only in this component's state and is cleared on use and on close. */
export function ReleaseDialog({ action, cellId, onClose }: ReleaseDialogProps) {
  const { repo, toast, refresh } = usePanel();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const open = cellId !== null;

  useEffect(() => {
    if (!open) setKey("");
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cellId || !key || busy) return;
    const typed = key;
    setKey("");
    setBusy(true);
    try {
      const text = action === "release" ? await release(repo, cellId, typed) : await clearFeedback(repo, cellId, typed);
      toast(text.slice(0, 200) || "Done.", "success");
      refresh();
      onClose();
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 403
          ? "Wrong admin key."
          : (err instanceof Error ? err.message : "Request failed.").slice(0, 200);
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  const label = action === "release" ? "Release" : "Clear feedback";
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setKey("");
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/15 bg-[var(--bg-elev,#1a2030)] p-4 text-[var(--fg,#e6e9f2)] shadow-xl">
          <Dialog.Title className="m-0 mb-2 text-base font-semibold">{`${label} ${cellId}?`}</Dialog.Title>
          <Dialog.Description className="mb-3 text-sm">{cellId ? gitWriteText(action, cellId) : ""}</Dialog.Description>
          <form onSubmit={submit}>
            <label htmlFor="bp-admin-key" className="mb-1 block text-sm">
              Admin key (typed for this action only, never stored)
            </label>
            <input
              id="bp-admin-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className={field}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className={btn}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" disabled={!key || busy} className={btn}>
                {busy ? "Working…" : `${label} ${cellId}`}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default ReleaseDialog;
