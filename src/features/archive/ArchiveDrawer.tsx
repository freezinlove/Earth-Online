import { CalendarDays, Image, MapPin, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";

export function ArchiveDrawer() {
  const trips = useAppStore((state) => state.trips);
  const selectTrip = useAppStore((state) => state.selectTrip);
  const setActivePanel = useAppStore((state) => state.setActivePanel);

  return (
    <section className="fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 shadow-ambient backdrop-blur-2xl md:px-24 md:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 flex items-start justify-between gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.34em] text-outline">Travel Archive</p>
            <h2 className="mt-2 font-serif text-4xl font-semibold text-primary md:text-5xl">旅行档案袋</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-on-surface-variant">
              点击档案会打开该 Trip 的照片、地点与待确认事项，不会直接跳回地球。需要定位时可在详情内选择照片或地点。
            </p>
          </div>
          <button
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/70 text-primary shadow-soft transition hover:bg-primary-fixed"
            aria-label="关闭旅行档案"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          {trips.map((trip) => (
            <button
              key={trip.id}
              className="group grid w-full gap-5 rounded-[24px] bg-white/62 p-4 text-left shadow-soft transition hover:-translate-y-0.5 hover:shadow-float md:grid-cols-[190px_1fr]"
              onClick={() => selectTrip(trip.id, "tripDetail")}
              type="button"
            >
              <img src={trip.coverUrl} alt={trip.title} className="h-40 w-full rounded-[18px] object-cover md:h-32" />
              <div className="flex min-w-0 flex-col justify-between gap-4 py-1">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-serif text-2xl font-semibold text-on-surface">{trip.title}</h3>
                    <span className="rounded-full bg-primary-fixed px-3 py-1 text-[11px] font-semibold text-primary">{trip.status}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-on-surface-variant">{trip.countries.join(" / ")} · {trip.cities.join(" / ")}</p>
                </div>
                <div className="flex flex-wrap gap-3 text-xs font-semibold text-outline">
                  <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} /> {trip.dateRange.start} - {trip.dateRange.end}</span>
                  <span className="inline-flex items-center gap-1.5"><Image size={14} /> {trip.photoCount} 张照片</span>
                  <span className="inline-flex items-center gap-1.5"><MapPin size={14} /> {trip.placeNodeCount} 个地点</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
