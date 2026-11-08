import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";

/** Storage key of the admin key. Remembered: localStorage. Not remembered: sessionStorage (this browser tab only). */
export const OWNER_KEY = "bp_owner_key";

type Kind = "local" | "session";

function area(kind: Kind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(kind: Kind): string | null {
  try {
    return area(kind)?.getItem(OWNER_KEY) || null;
  } catch {
    return null;
  }
}

function drop(kind: Kind): void {
  try {
    area(kind)?.removeItem(OWNER_KEY);
  } catch {
    // nothing to remove
  }
}

/** The stored admin key (tab first, then this computer), or null. */
export function readOwnerKey(): string | null {
  return read("session") ?? read("local");
}

/** Keeps the key in exactly one place: localStorage when remembered, else sessionStorage. */
export function saveOwnerKey(key: string, remember: boolean): void {
  try {
    area(remember ? "local" : "session")?.setItem(OWNER_KEY, key);
  } catch {
    // the key is asked again next time
  }
  drop(remember ? "session" : "local");
}

/** Removes the key from both storages. */
export function forgetOwnerKey(): void {
  drop("local");
  drop("session");
}

const box =
  "fixed left-1/2 top-1/2 z-50 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[color:var(--border,#8884)] " +
  "bg-[color:var(--surface,#fff)] p-5 text-[color:var(--text,#111)] shadow-xl";
const btn = "rounded-md border border-[color:var(--border,#8884)] px-3 py-1.5 text-sm";
const primary = "rounded-md bg-[#5B9DFF] px-3 py-1.5 text-sm font-medium text-[#0b1020]";

interface FormProps {
  retry: boolean;
  onSubmit: (key: string, remember: boolean) => void;
  onCancel: () => void;
}

/** The typed key lives only here and is gone when the dialog closes. */
function KeyForm({ retry, onSubmit, onCancel }: FormProps) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const [forgotten, setForgotten] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key) return;
    onSubmit(key, remember);
  };

  const forget = () => {
    forgetOwnerKey();
    setValue("");
    setForgotten(true);
  };

  return (
    <Dialog.Content className={box}>
      <Dialog.Title className="text-base font-semibold">Admin key</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm">
        Enter the admin key once to start the steward. It is sent only to this panel's server and is never put in a link. If you
        tick Remember on this computer, the key is kept as plain text in this browser's storage; otherwise it is kept only until
        this browser tab is closed.
      </Dialog.Description>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Admin key
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={200}
            autoComplete="off"
            autoFocus
            className="rounded-md border border-[color:var(--border,#8884)] bg-transparent px-2 py-1.5"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember on this computer
        </label>
        {retry && (
          <p role="alert" className="text-sm text-[#FF6B5E]">
            That key was not accepted. Enter the admin key again.
          </p>
        )}
        {forgotten && (
          <p role="status" className="text-sm">
            The saved key was forgotten.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={forget} className={btn}>
            Forget the key
          </button>
          <button type="button" onClick={onCancel} className={btn}>
            Cancel
          </button>
          <button type="submit" className={primary}>
            Continue
          </button>
        </div>
      </form>
    </Dialog.Content>
  );
}

interface Props extends FormProps {
  open: boolean;
}

/** Asks for the admin key. The caller gets the key through onSubmit and keeps it in no state. */
export default function OwnerKeyDialog({ open, retry, onSubmit, onCancel }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        {open && <KeyForm retry={retry} onSubmit={onSubmit} onCancel={onCancel} />}
      </Dialog.Portal>
    </Dialog.Root>
  );
}
