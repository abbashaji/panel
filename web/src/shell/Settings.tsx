import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { readStore, writeStore } from "../core/storage";
import { usePanel } from "../core/store";
import { WHO_KEY } from "./Header";

// Same rule as the launcher: a display name of 1 to 40 word characters, spaces, dots or dashes.
const WHO_RE = /^[\w .-]{1,40}$/;

const STEPS: [string, string][] = [
  ["Click Start in the panel", "On a card, in the inspector, or double-click. The panel sends only repo and cell id."],
  ["Panel reserves the cell", "The Worker holds it for you for 10 minutes. It learns the cell id and your name, nothing from your browser."],
  ["Launcher window opens", "A small local Windows window lists your profiles, shows the prompt, and asks you to confirm."],
  ["Chrome opens your profile", "The chosen profile opens claude.ai/new with the prompt filled. You press Send."],
  ["Chat claims the cell", "next_cell with cell_id returns CLAIMED. The launcher already saved cell, profile and time on your PC."],
  ["Card shows you", "Open chat reopens that profile on claude.ai. Records are deleted when the cell turns green."],
];

const NOTES: { title: string; color: string; items: string[] }[] = [
  {
    title: "STAYS ON YOUR PC",
    color: "var(--st-done)",
    items: [
      "Profile names: read by the launcher, shown only in its own window",
      "A small record per cell: cell id, profile, time, and an optional pasted chat link",
      "The launcher opens no network connection",
    ],
  },
  {
    title: "LEAVES YOUR PC (BY DESIGN)",
    color: "var(--accent)",
    items: [
      "Repo and cell id, and your name, to the Worker for the reservation",
      "The prompt, inside the claude.ai link, because that is the chat you asked for",
    ],
  },
  {
    title: "HONEST LIMITS",
    color: "var(--st-ready)",
    items: [
      "Windows only. First click: Chrome asks permission to open the launcher",
      "No automatic chat link and no automatic release at the usage limit. Use Release in the panel",
      "The page that calls the launcher is untrusted, so the launcher validates it and always asks you to confirm",
    ],
  },
];

export default function Settings({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { theme, toggleTheme } = usePanel();
  const [name, setName] = useState(() => readStore(WHO_KEY) ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = () => {
    const v = name.trim();
    if (!WHO_RE.test(v)) {
      setErr("Use 1 to 40 letters, digits, spaces, dots or dashes.");
      setSaved(false);
      return;
    }
    writeStore(WHO_KEY, v);
    setErr(null);
    setSaved(true);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40" style={{ background: "rgba(5,8,16,.7)" }} />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(1040px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border p-7"
          style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text)" }}
        >
          <div className="flex items-center">
            <Dialog.Title style={{ font: "700 18px var(--font-sans)" }}>Settings</Dialog.Title>
            <Dialog.Close className="ml-auto rounded px-2 py-1" aria-label="Close" style={{ color: "var(--muted)" }}>
              ×
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Display name, theme and how the Start button works.</Dialog.Description>

          <div className="mt-5 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1" style={{ font: "600 11px var(--font-sans)", letterSpacing: ".08em", color: "var(--muted-3)" }}>
              DISPLAY NAME
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
                maxLength={40}
                className="rounded border px-2 py-1.5"
                style={{ width: 240, background: "var(--surface-2)", borderColor: "var(--raised-border)", color: "var(--text)", font: "500 13px var(--font-sans)", letterSpacing: 0 }}
              />
            </label>
            <button type="button" onClick={save} className="rounded px-3 py-1.5" style={{ background: "var(--accent)", color: "#06142b", font: "700 13px var(--font-sans)" }}>
              Save
            </button>
            <button type="button" onClick={toggleTheme} className="rounded border px-3 py-1.5" style={{ borderColor: "var(--raised-border)", font: "600 13px var(--font-sans)" }}>
              Theme: {theme === "dark" ? "Dark" : "Light"}
            </button>
            {err && (
              <span role="alert" style={{ color: "var(--danger)", font: "500 12px var(--font-sans)" }}>
                {err}
              </span>
            )}
            {saved && <span style={{ color: "var(--st-done)", font: "500 12px var(--font-sans)" }}>Saved</span>}
          </div>

          <h2 className="mt-7" style={{ font: "700 18px var(--font-sans)" }}>
            What happens when a teammate clicks Start (Windows, local launcher, no extension)
          </h2>
          <ol className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            {STEPS.map(([title, body], i) => (
              <li key={title} className="rounded-xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                <span
                  aria-hidden="true"
                  className="mb-3 flex items-center justify-center"
                  style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--accent)", color: "#06142b", font: "700 11px var(--font-sans)" }}
                >
                  {i + 1}
                </span>
                <div style={{ font: "700 13px var(--font-sans)" }}>{title}</div>
                <p className="mt-1" style={{ font: "500 11.5px/1.5 var(--font-sans)", color: "var(--muted)" }}>
                  {body}
                </p>
              </li>
            ))}
          </ol>

          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            {NOTES.map((n) => (
              <section key={n.title} className="rounded-xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
                <h3 style={{ font: "700 11px var(--font-sans)", letterSpacing: ".08em", color: n.color }}>{n.title}</h3>
                <ul className="mt-3 list-disc pl-4" style={{ font: "500 12.5px/1.5 var(--font-sans)", color: "#d5dbe8" }}>
                  {n.items.map((t) => (
                    <li key={t} className="mt-1.5">
                      {t}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
