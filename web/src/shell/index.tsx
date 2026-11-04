import { useEffect, useState, type ReactNode } from "react";
import Activity from "./ActivityPanel";
import Header from "./Header";
import Palette from "./Palette";
import PanelToggle, { panelId } from "./PanelToggle";
import Settings from "./Settings";
import Sidebar from "./Sidebar";
import { usePanelVisibility, type PanelName } from "./usePanelVisibility";

/** Collapsed 28 px rail that holds only the show button. */
function Rail({ panel, side, onShow }: { panel: PanelName; side: "left" | "right"; onShow: () => void }) {
  return (
    <div
      id={panelId(panel)}
      data-testid={`rail-${panel}`}
      className="flex shrink-0 flex-col items-center pt-2"
      style={{ width: 28, background: "var(--surface)", [side === "left" ? "borderRight" : "borderLeft"]: "1px solid var(--border)" }}
    >
      <PanelToggle panel={panel} visible={false} onToggle={onShow} />
    </div>
  );
}

/**
 * App frame: header (56 px), sidebar (196 px), center column (main view, then the 172 px activity panel),
 * optional aside (the inspector, 320 px), Ctrl+K palette and the settings dialog.
 */
export default function Shell({ children, aside }: { children?: ReactNode; aside?: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { visible, toggle } = usePanelVisibility();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header onSearch={() => setSearchOpen(true)} />
      <div className="flex min-h-0 flex-1">
        {visible.sidebar ? (
          <Sidebar onSettings={() => setSettingsOpen(true)} onHide={() => toggle("sidebar")} />
        ) : (
          <Rail panel="sidebar" side="left" onShow={() => toggle("sidebar")} />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">{children}</div>
          <Activity visible={visible.activity} onToggle={() => toggle("activity")} />
        </div>
        {aside ? (
          visible.inspector ? (
            <div id={panelId("inspector")} className="relative flex shrink-0">
              <PanelToggle
                panel="inspector"
                visible
                onToggle={() => toggle("inspector")}
                className="absolute z-10"
                style={{ left: -14, top: 12, background: "var(--surface)", border: "1px solid var(--border)" }}
              />
              {aside}
            </div>
          ) : (
            <Rail panel="inspector" side="right" onShow={() => toggle("inspector")} />
          )
        ) : null}
      </div>
      <Palette open={searchOpen} onOpenChange={setSearchOpen} />
      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
