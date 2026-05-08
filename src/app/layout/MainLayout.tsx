import { Archive, Bell, Globe2, MapPinned, Plus, Search, Settings } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { useAppStore, type AppPanel } from "@/store/appStore";

const navItems: Array<{ panel: Exclude<AppPanel, "globe" | "upload" | "import" | "tripDetail">; label: string; icon: typeof Archive }> = [
  { panel: "archive", label: "旅行档案", icon: Archive },
  { panel: "manual", label: "手动整理", icon: MapPinned },
  { panel: "settings", label: "本地设置", icon: Settings },
];

const navPanelOrder: AppPanel[] = ["upload", "globe", ...navItems.map((item) => item.panel)];
const primaryNavExitDuration = 240;

export function MainLayout({ children }: { children: ReactNode }) {
  const activePanel = useAppStore((state) => state.activePanel);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const pendingItems = useAppStore((state) => state.pendingItems);
  const [indicatorMotion, setIndicatorMotion] = useState<{
    direction: "up" | "down";
    from: AppPanel;
    id: number;
    to: AppPanel;
  } | null>(null);
  const [shouldRenderPrimaryNav, setShouldRenderPrimaryNav] = useState(activePanel !== "tripDetail");
  const [isPrimaryNavClosing, setIsPrimaryNavClosing] = useState(false);
  const motionTimer = useRef<number | undefined>(undefined);
  const primaryNavTimer = useRef<number | undefined>(undefined);
  const homeState = activePanel === "globe" ? "active" : "covered";
  const openPendingCount = pendingItems.filter((item) => item.status === "open").length;
  const moveToPanel = (panel: AppPanel) => {
    const fromIndex = navPanelOrder.indexOf(activePanel);
    const toIndex = navPanelOrder.indexOf(panel);

    if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
      setIndicatorMotion({
        direction: toIndex > fromIndex ? "down" : "up",
        from: activePanel,
        id: Date.now(),
        to: panel,
      });
    } else {
      setIndicatorMotion(null);
    }

    setActivePanel(panel);
  };
  const togglePanel = (panel: AppPanel) => moveToPanel(activePanel === panel ? "globe" : panel);

  useEffect(() => {
    if (!indicatorMotion) return;

    window.clearTimeout(motionTimer.current);
    motionTimer.current = window.setTimeout(() => setIndicatorMotion(null), 360);
    return () => window.clearTimeout(motionTimer.current);
  }, [indicatorMotion]);

  useEffect(() => {
    window.clearTimeout(primaryNavTimer.current);

    if (activePanel !== "tripDetail") {
      setShouldRenderPrimaryNav(true);
      setIsPrimaryNavClosing(false);
      return;
    }

    if (shouldRenderPrimaryNav) {
      setIsPrimaryNavClosing(true);
      primaryNavTimer.current = window.setTimeout(() => {
        setShouldRenderPrimaryNav(false);
        setIsPrimaryNavClosing(false);
      }, primaryNavExitDuration);
    }

    return () => window.clearTimeout(primaryNavTimer.current);
  }, [activePanel, shouldRenderPrimaryNav]);

  return (
    <div className="app-shell relative min-h-screen overflow-hidden bg-background text-on-surface" data-home-state={homeState}>
      <div className="paper-grain" />

      <header className="home-chrome pointer-events-none fixed inset-x-0 top-0 z-40 flex items-start justify-between px-5 py-5 md:px-8 md:py-7" data-home-state={homeState}>
          <button
            className="pointer-events-auto rounded-full px-2 py-1 text-left font-serif text-2xl font-bold text-primary md:text-[28px]"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            Earth_Online
          </button>
          <div className="pointer-events-auto flex items-center gap-3">
            <button
              className="group hidden h-11 w-11 place-items-center text-on-surface-variant transition hover:text-primary md:grid"
              aria-label="记忆搜索"
              title="记忆搜索"
              onClick={() => togglePanel("search")}
              type="button"
            >
              <Search className="transition-transform group-hover:scale-110" size={20} strokeWidth={2.15} />
            </button>
            <button
              className="group relative grid h-11 w-11 place-items-center text-on-surface-variant transition hover:text-primary"
              aria-label="导入确认"
              title="导入确认"
              onClick={() => togglePanel("import")}
              type="button"
            >
              <Bell className="transition-transform group-hover:scale-110" size={20} strokeWidth={2.15} />
              {openPendingCount > 0 ? (
                <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
              ) : null}
            </button>
          </div>
        </header>

      {shouldRenderPrimaryNav ? (
      <nav
        className="primary-nav fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-1.5 md:bottom-auto md:left-8 md:top-1/2 md:-translate-x-0 md:-translate-y-1/2 md:flex-col"
        data-active-panel={activePanel}
        data-state={isPrimaryNavClosing ? "closing" : "open"}
      >
        <button
          className={clsx(
            "group relative grid h-11 w-11 place-items-center rounded-full text-primary transition active:scale-95",
          )}
          aria-label="导入图片"
          onClick={() => togglePanel("upload")}
          type="button"
        >
          <Plus className={clsx("transition-transform group-hover:scale-110", activePanel === "upload" && "nav-icon-pop")} size={20} strokeWidth={1.9} />
          {activePanel === "upload" ? (
            <span
              key={indicatorMotion?.to === "upload" ? indicatorMotion.id : "upload-active"}
              className={clsx("nav-indicator", indicatorMotion?.to === "upload" && `nav-indicator-enter-${indicatorMotion.direction}`)}
            />
          ) : null}
          {indicatorMotion?.from === "upload" ? (
            <span key={`${indicatorMotion.id}-upload-exit`} className={clsx("nav-indicator", `nav-indicator-exit-${indicatorMotion.direction}`)} />
          ) : null}
        </button>
        <button
          className={clsx(
            "group relative grid h-11 w-11 place-items-center rounded-full transition hover:text-primary active:scale-95",
            activePanel === "globe" ? "text-primary" : "text-on-surface-variant",
          )}
          onClick={() => moveToPanel("globe")}
          aria-label="时空主界面"
          title="时空主界面"
          type="button"
        >
          <Globe2 className={clsx("transition-transform group-hover:scale-110", activePanel === "globe" && "nav-icon-pop")} size={20} strokeWidth={1.9} />
          {activePanel === "globe" ? (
            <span
              key={indicatorMotion?.to === "globe" ? indicatorMotion.id : "globe-active"}
              className={clsx("nav-indicator", indicatorMotion?.to === "globe" && `nav-indicator-enter-${indicatorMotion.direction}`)}
            />
          ) : null}
          {indicatorMotion?.from === "globe" ? (
            <span key={`${indicatorMotion.id}-globe-exit`} className={clsx("nav-indicator", `nav-indicator-exit-${indicatorMotion.direction}`)} />
          ) : null}
        </button>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activePanel === item.panel;
          return (
            <button
              key={item.panel}
              className={clsx(
                "group relative grid h-11 w-11 place-items-center rounded-full transition hover:text-primary active:scale-95",
                isActive ? "text-primary" : "text-on-surface-variant",
              )}
              onClick={() => togglePanel(item.panel)}
              aria-label={item.label}
              title={item.label}
              type="button"
            >
              <Icon className={clsx("transition-transform group-hover:scale-110", isActive && "nav-icon-pop")} size={20} strokeWidth={1.9} />
              {isActive ? (
                <span
                  key={indicatorMotion?.to === item.panel ? indicatorMotion.id : `${item.panel}-active`}
                  className={clsx("nav-indicator", indicatorMotion?.to === item.panel && `nav-indicator-enter-${indicatorMotion.direction}`)}
                />
              ) : null}
              {indicatorMotion?.from === item.panel ? (
                <span key={`${indicatorMotion.id}-${item.panel}-exit`} className={clsx("nav-indicator", `nav-indicator-exit-${indicatorMotion.direction}`)} />
              ) : null}
              <span className="pointer-events-none absolute left-14 hidden whitespace-nowrap rounded-full bg-on-surface px-3 py-1.5 text-xs text-white opacity-0 shadow-soft transition group-hover:opacity-100 md:block">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
      ) : null}

      <main className="relative z-10 min-h-screen">{children}</main>
    </div>
  );
}
