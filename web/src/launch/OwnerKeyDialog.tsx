import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";

/** Storage name of the admin key: sessionStorage (this tab only) or, with "Remember on this computer", localStorage. */
export const OWNER_KEY = "bp_owner_key";

function store(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(kind: "local" | "session"): string | null {
  try {
    return store(kind)?.getItem(OWNER_KEY) || null;
  } catch {
    return null;
  }
}

function write(kind: "local" | "session", value: string | null): void {
  try {
    const s = store(kind);
    if (!s) return;
    if (value === null) s.removeItem(OWNER_KEY);
    else s.setItem(OWNER_KEY, value);
  } catch {
    // storage is blocked: the key is simply asked for again
  }
}

/** The saved admin key (this tab first, then this computer), or null. */
export function readOwnerKey(): string | null {
  return read("session") ?? read("local");
}

/** remember: localStorage only; otherwise sessionStorage only. */
export function saveOwnerKey(key: string, remember: boolean): void {
  write(remember ? "local" : "session", key);
  write(remember ? "session" : "local", null);
}

/** Removes the key from both storages. */
export function forgetOwnerKey(): void {
  write("session", null);
  write("local", null);
}

const box =
  "fixed left-1/2 top-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[color:var(--border,#8884)] " +
  "bg-[color:var(--surface,#fff)] p-5 text-[color:var(--text,#111)] shadow-xl";
const btn = "rounded-md border border-[color:var(--border,#8884)] px-3 py-1.5 text-sm";
const primary = "rounded-md bg-[#5B9DFF] px-3 py-1.5 text-sm font-medium text-[#0b1020]";

/** The key lives only in this form's state; it is gone when the dialog closes. */
function KeyForm({ wrong, onSubmit }: { wrong: boolean; onSubmit: (key: string, remember: boolean) => void }) {
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [forgot, setForgot] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (k) onSubmit(k, remember);
  };

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        Admin key
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="rounded-md border border-[color:var(--border,#8884)] bg-transparent px-2 py-1.5"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember on this computer
      </label>
      {wrong && (
        <p role="alert" className="text-sm text-[#FF6B5E]">
          That key was not accepted. Enter it again.
        </p>
      )}
      {forgot && (
        <p role="status" className="text-sm">
          The saved key was removed.
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className={btn}
          onClick={() => {
            forgetOwnerKey();
            setKey("");
            setForgot(true);
          }}
        >
          Forget the key
        </button>
        <div className="flex gap-2">
          <Dialog.Close className={btn}>Cancel</Dialog.Close>
          <button type="submit" className={primary}>
            Start steward
          </button>
        </div>
      </div>
    </form>
  );
}

/** Asks for the admin key. Calls onSubmit(key, remember) once; the caller must not keep the key beyond the request. */
export default function OwnerKeyDialog({
  open,
  wrong = false,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  wrong?: boolean;
  onSubmit: (key: string, remember: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className={box}>
          <Dialog.Title className="text-base font-semibold">Start the steward</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm">
            Starting the steward needs the admin key. Type it once; it is sent to the Worker only, never put in a link. By default it
            is kept for this browser tab only. If you tick the box, it is saved in plain browser storage on this computer, where
            anyone using this browser profile can read it.
          </Dialog.Description>
          <KeyForm wrong={wrong} onSubmit={onSubmit} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
