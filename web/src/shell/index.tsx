import { useEffect, useState, type ReactNode } from "react";
import Activity from "./Activity";
import Header from "./Header";
import Palette from "./Palette";
import Sidebar from "./Sidebar";

/** App frame: header (56 px), sidebar (196 px), main slot, activity strip, Ctrl+K palette. */
export default function Shell({ children }: { children?: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);

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
        <Sidebar />
        {children}
      </div>
      <Activity />
      <Palette open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
