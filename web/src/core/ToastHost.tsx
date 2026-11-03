import { usePanel } from "./store";

const BORDER = { info: "var(--accent)", success: "var(--st-done)", error: "var(--danger)" } as const;

/** Bottom-right toast stack. Polite live region so screen readers announce results. */
export function ToastHost() {
  const { toasts, dismissToast } = usePanel();
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg"
          style={{ background: "var(--surface-2)", borderColor: BORDER[t.kind], color: "var(--text)" }}
        >
          <span className="flex-1 break-words">{t.msg}</span>
          <button type="button" aria-label="Dismiss" className="px-1" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
