import { useEffect, useState, type ReactNode } from "react";
import Activity from "./ActivityPanel";
import Header from "./Header";
import Palette from "./Palette";
import Settings from "./Settings";
import Sidebar from "./Sidebar";

/**
 * App frame: header (56 px), sidebar (196 px), center column (main view, then the 172 px activity panel),
 * optional aside (the inspector, 320 px), Ctrl+K palette and the settings dialog.
 */
export default function Shell({ children, aside }: { children?: ReactNode; aside?: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
        <Sidebar onSettings={() => setSettingsOpen(true)} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">{children}</div>
          <Activity />
        </div>
        {aside}
      </div>
      <Palette open={searchOpen} onOpenChange={setSearchOpen} />
      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
