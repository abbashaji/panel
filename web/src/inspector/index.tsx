import { useEffect, useState } from "react";
import { usePanel } from "../core/store";
import type { PanelCell } from "../core/types";
import { CellDetails, MultiSummary } from "./CellDetails";
import ReleaseDialog, { type AdminAction } from "./ReleaseDialog";

/** Right panel (320 px): details and admin actions for the selected cell(s). */
export default function Inspector() {
  const { state, selection, registerActions } = usePanel();
  const [dialog, setDialog] = useState<{ action: AdminAction; id: string } | null>(null);

  // the graph banner calls actions.requestRelease(id); this panel owns the confirm dialog
  useEffect(() => registerActions({ requestRelease: (id) => setDialog({ action: "release", id }) }), [registerActions]);

  const cells = state?.cells ?? [];
  const picked = selection.map((id) => cells.find((c) => c.id === id)).filter((c): c is PanelCell => c !== undefined);

  let body;
  if (!state || picked.length === 0) {
    body = <p className="m-0 text-sm opacity-70">Select a cell to see its details.</p>;
  } else if (picked.length > 1) {
    body = <MultiSummary cells={picked} />;
  } else {
    body = <CellDetails cell={picked[0]} repo={state.repo} onAdmin={(action) => setDialog({ action, id: picked[0].id })} />;
  }

  return (
    <aside aria-label="Inspector" className="h-full w-80 shrink-0 overflow-y-auto border-l border-white/10 p-3">
      {body}
      <ReleaseDialog action={dialog?.action ?? "release"} cellId={dialog?.id ?? null} onClose={() => setDialog(null)} />
    </aside>
  );
}
