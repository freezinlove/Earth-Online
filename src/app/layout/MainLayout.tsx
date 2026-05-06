import { Archive, Bell, BookOpen, Globe2, MapPinned, Plus, Search, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { clsx } from "clsx";
import { useAppStore, type AppPanel } from "@/store/appStore";

const navItems: Array<{ panel: Exclude<AppPanel, "globe" | "upload" | "import" | "tripDetail">; label: string; icon: typeof Archive }> = [
  { panel: "archive", label: "旅行档案", icon: Archive },
  { panel: "search", label: "记忆搜索", icon: Search },
  { panel: "manual", label: "手动整理", icon: MapPinned },
  { panel: "settings", label: "本地设置", icon: Settings },
];

export function MainLayout({ children }: { children: ReactNode }) {
  const activePanel = useAppStore((state) => state.activePanel);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const pendingItems = useAppStore((state) => state.pendingItems);
  const trips = useAppStore((state) => state.trips);
  const photos = useAppStore((state) => state.photos);
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const showChrome = activePanel === "globe";
  const openPendingCount = pendingItems.filter((item) => item.status === "open").length;
  const trip = trips.find((item) => item.id === selectedTripId);
  const selectedPhotos = photos.filter((photo) => photo.tripId === selectedTripId);
  const togglePanel = (panel: AppPanel) => setActivePanel(activePanel === panel ? "globe" : panel);

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-on-surface">
      <div className="paper-grain" />

      {showChrome ? (
        <header className="pointer-events-none fixed inset-x-0 top-0 z-40 flex items-start justify-between px-5 py-5 md:px-8 md:py-7">
          <button
            className="pointer-events-auto rounded-full px-2 py-1 text-left font-serif text-2xl font-bold text-primary md:text-[28px]"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            Earth_Online
          </button>
          <div className="pointer-events-auto flex items-center gap-3">
            <button
              className="hidden items-center gap-2 rounded-full bg-white/70 px-4 py-2 text-sm font-semibold text-on-surface-variant shadow-soft backdrop-blur-xl transition hover:text-primary md:inline-flex"
              onClick={() => togglePanel("search")}
              type="button"
            >
              <Search size={16} />
              京都 夜景
            </button>
            <button
              className="relative grid h-11 w-11 place-items-center rounded-full bg-white/70 text-on-surface-variant shadow-soft backdrop-blur-xl transition hover:text-primary"
              aria-label="导入确认"
              onClick={() => togglePanel("import")}
              type="button"
            >
              <Bell size={19} />
              {openPendingCount > 0 ? (
                <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold text-white">
                  {openPendingCount}
                </span>
              ) : null}
            </button>
          </div>
        </header>
      ) : null}

      <nav className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 md:bottom-auto md:left-8 md:top-1/2 md:-translate-x-0 md:-translate-y-1/2 md:flex-col">
        <button
          className="grid h-12 w-12 place-items-center rounded-full bg-primary text-white shadow-float transition hover:scale-105"
          aria-label="导入图片"
          onClick={() => togglePanel("upload")}
          type="button"
        >
          <Plus size={22} />
        </button>
        <button
          className={clsx(
            "group relative grid h-11 w-11 place-items-center rounded-full transition",
            activePanel === "globe" ? "bg-primary text-white" : "bg-white/65 text-on-surface-variant hover:bg-primary-fixed hover:text-primary",
          )}
          onClick={() => setActivePanel("globe")}
          aria-label="时空主界面"
          title="时空主界面"
          type="button"
        >
          <Globe2 size={19} />
        </button>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activePanel === item.panel;
          return (
            <button
              key={item.panel}
              className={clsx(
                "group relative grid h-11 w-11 place-items-center rounded-full transition",
                isActive ? "bg-primary text-white" : "bg-white/65 text-on-surface-variant hover:bg-primary-fixed hover:text-primary",
              )}
              onClick={() => togglePanel(item.panel)}
              aria-label={item.label}
              title={item.label}
              type="button"
            >
              <Icon size={19} />
              <span className="pointer-events-none absolute left-14 hidden whitespace-nowrap rounded-full bg-on-surface px-3 py-1.5 text-xs text-white opacity-0 shadow-soft transition group-hover:opacity-100 md:block">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      <main className="relative z-10 min-h-screen">{children}</main>

      {showChrome && trip ? (
        <aside className="ai-narrative-block fixed right-5 top-24 z-30 hidden w-[min(22vw,380px)] min-w-72 rounded-[24px] p-6 shadow-ambient backdrop-blur-2xl xl:block">
          <div className="mb-4 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-tertiary-fixed text-tertiary">
              <BookOpen size={18} />
            </div>
            <div>
              <p className="font-serif text-lg font-semibold">正在回看</p>
              <p className="text-xs text-on-surface-variant">{trip.title}</p>
            </div>
          </div>
          <p className="text-sm leading-6 text-on-surface-variant">
            时间光标停在 {trip.dateRange.start} 至 {trip.dateRange.end}。当前地球高亮 {selectedPhotos.length} 张照片、{trip.placeNodeCount} 个地点节点和一条基础路线。
          </p>
          <button
            className="mt-5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white shadow-soft"
            onClick={() => setActivePanel("tripDetail")}
            type="button"
          >
            查看档案详情
          </button>
        </aside>
      ) : null}
    </div>
  );
}
