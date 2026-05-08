import type { CSSProperties } from "react";
import { ArrowUpRight, CalendarDays, Image, MapPin } from "lucide-react";
import type { Trip } from "@/domain/models";
import { useAppStore } from "@/store/appStore";

const statusMeta: Record<Trip["status"], { label: string; tone: string }> = {
  archived: { label: "archived", tone: "bg-outline" },
  confirmed: { label: "confirmed", tone: "bg-secondary" },
  draft: { label: "draft", tone: "bg-primary" },
  ongoing: { label: "ongoing", tone: "bg-tertiary" },
  pending: { label: "pending", tone: "bg-primary-container" },
};

function groupTripsByYear(trips: Trip[]) {
  return [...trips]
    .sort((left, right) => right.dateRange.start.localeCompare(left.dateRange.start))
    .reduce<Array<{ year: string; trips: Trip[] }>>((groups, trip) => {
      const year = trip.dateRange.start.slice(0, 4);
      const current = groups[groups.length - 1];

      if (current?.year === year) {
        current.trips.push(trip);
      } else {
        groups.push({ year, trips: [trip] });
      }

      return groups;
    }, []);
}

export function ArchiveDrawer({ isClosing = false }: { isClosing?: boolean }) {
  const trips = useAppStore((state) => state.trips);
  const selectTrip = useAppStore((state) => state.selectTrip);
  const groupedTrips = groupTripsByYear(trips);
  const totalPhotos = trips.reduce((count, trip) => count + trip.photoCount, 0);
  const totalPlaces = trips.reduce((count, trip) => count + trip.placeNodeCount, 0);

  return (
    <section
      className="archive-drawer fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12"
      data-state={isClosing ? "closing" : "open"}
    >
      <div className="mx-auto max-w-6xl">
        <div className="archive-heading mb-8 md:mb-12">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.34em] text-outline">Travel Archive</p>
            <h2 className="mt-2 font-serif text-4xl font-semibold leading-tight text-primary md:text-6xl">旅行档案袋</h2>
          </div>
        </div>

        <div className="archive-index mb-10 flex flex-wrap gap-x-6 gap-y-2 border-y border-outline-variant/45 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-outline">
          <span>{trips.length} trips</span>
          <span>{totalPhotos} photos</span>
          <span>{totalPlaces} places</span>
        </div>

        <div className="space-y-11">
          {groupedTrips.map((group) => (
            <section key={group.year} className="archive-year-grid">
              <div className="archive-year-label font-serif text-3xl text-primary/70 md:text-4xl">{group.year}</div>
              <div className="min-w-0 border-t border-outline-variant/50">
                {group.trips.map((trip, index) => {
                  const status = statusMeta[trip.status];

                  return (
                    <button
                      key={trip.id}
                      className="archive-entry group grid w-full gap-5 border-b border-outline-variant/50 py-5 text-left transition md:grid-cols-[210px_1fr_auto] md:items-center md:py-6"
                      onClick={() => selectTrip(trip.id, "tripDetail")}
                      style={{ "--archive-entry-delay": `${index * 80}ms` } as CSSProperties}
                      type="button"
                    >
                      <span className="archive-entry-media block h-40 w-full overflow-hidden rounded-lg bg-surface-container md:h-32">
                        <img src={trip.coverUrl} alt={trip.title} className="h-full w-full object-cover" />
                      </span>

                      <span className="flex min-w-0 flex-col gap-4">
                        <span>
                          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <h3 className="archive-entry-title font-serif text-2xl font-semibold leading-tight text-on-surface md:text-3xl">{trip.title}</h3>
                            <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-outline">
                              <span className={`h-1.5 w-1.5 rounded-full ${status.tone}`} />
                              {status.label}
                            </span>
                          </span>
                          <span className="mt-3 block text-sm leading-6 text-on-surface-variant">
                            {trip.countries.join(" / ")} · {trip.cities.join(" / ")}
                          </span>
                        </span>

                        <span className="flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold text-outline">
                          <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} /> {trip.dateRange.start} - {trip.dateRange.end}</span>
                          <span className="inline-flex items-center gap-1.5"><Image size={14} /> {trip.photoCount} 张照片</span>
                          <span className="inline-flex items-center gap-1.5"><MapPin size={14} /> {trip.placeNodeCount} 个地点</span>
                        </span>
                      </span>

                      <span className="archive-entry-action hidden h-10 w-10 place-items-center rounded-full text-primary md:grid">
                        <ArrowUpRight size={18} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          {trips.length === 0 ? (
            <div className="border-y border-outline-variant/50 py-12 text-sm text-on-surface-variant">
              暂无旅行档案。
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
