import { useState } from "react";

/** Relative to the current /panel/ path, so it resolves next to the panel's index page. */
export const AUTOSEND_SCRIPT_HREF = "blueprint-autosend.user.js";

const muted = { font: "500 12px var(--font-sans)", color: "var(--muted, #A9B2C6)" } as const;

/** Collapsed-by-default block that offers the optional auto-send userscript. */
export default function AutoSendHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="mt-3"
      style={{ border: "1px solid var(--border, #1E2740)", borderRadius: 8, padding: "8px 12px" }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ font: "600 12.5px var(--font-sans)", color: "var(--text, #E8ECF5)" }}
      >
        {open ? "\u25BE" : "\u25B8"} Auto-send helper (optional)
      </button>
      {open && (
        <div className="mt-2" data-testid="autosend-help-body">
          <p style={muted}>
            A userscript that presses Send for you in the chat tabs the launcher opens, so each cell starts without a manual click.
          </p>
          <p className="mt-2">
            <a
              href={AUTOSEND_SCRIPT_HREF}
              target="_blank"
              rel="noopener noreferrer"
              style={{ font: "600 12.5px var(--font-sans)", color: "var(--accent, #5B9DFF)" }}
            >
              Install blueprint-autosend.user.js
            </a>
          </p>
          <ol className="mt-2 list-decimal pl-5" style={muted}>
            <li>Install a userscript manager (Tampermonkey or Violentmonkey) in each browser profile the launcher opens.</li>
            <li>Install the script with the link above.</li>
            <li>From the manager menu, set the allowed repos to this repo.</li>
          </ol>
          <p className="mt-2" style={muted}>
            The launcher checkbox &ldquo;Auto-send in the browser&rdquo; must also be on. Steward chats never auto-send.
          </p>
        </div>
      )}
    </div>
  );
}
