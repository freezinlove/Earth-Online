import type { CSSProperties } from "react";
import { useState } from "react";
import { CalendarDays, Check, Image, MapPin, X } from "lucide-react";
import { countryLabel, tripLabel } from "@/domain/labels";
import { useI18n } from "@/i18n/useI18n";
import type { Trip } from "@/domain/models";
import { useAppStore } from "@/store/appStore";

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
  const { locale, t } = useI18n();
  const trips = useAppStore((state) => state.trips);
  const selectTrip = useAppStore((state) => state.selectTrip);
  const deleteTrip = useAppStore((state) => state.deleteTrip);
  const [confirmingTripId, setConfirmingTripId] = useState<string>();
  const [deletingTripId, setDeletingTripId] = useState<string>();
  const groupedTrips = groupTripsByYear(trips);
  const totalPhotos = trips.reduce((count, trip) => count + trip.photoCount, 0);
  const totalPlaces = trips.reduce((count, trip) => count + trip.placeNodeCount, 0);

  const requestDeleteTrip = (tripId: string) => {
    setConfirmingTripId((current) => (current === tripId ? undefined : tripId));
  };

  const confirmDeleteTrip = async (tripId: string) => {
    setDeletingTripId(tripId);
    try {
      await deleteTrip(tripId);
      setConfirmingTripId(undefined);
    } finally {
      setDeletingTripId(undefined);
    }
  };

  return (
    <section
      className="archive-drawer fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12"
      data-state={isClosing ? "closing" : "open"}
    >
      <div className="mx-auto max-w-6xl">
        <div className="archive-heading mb-8 md:mb-12">
          <div>
            <h2 className="font-serif text-4xl font-semibold leading-tight text-primary md:text-6xl">{t("archive")}</h2>
          </div>
        </div>

        <div className="archive-index mb-10 flex flex-wrap gap-x-6 gap-y-2 border-y border-outline-variant/45 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-outline">
          <span>{trips.length} {t("tripCount")}</span>
          <span>{totalPhotos} {t("photoCount")}</span>
          <span>{totalPlaces} {t("placeCount")}</span>
        </div>

        <div className="space-y-11">
          {groupedTrips.map((group) => (
            <section key={group.year} className="archive-year-grid">
              <div className="archive-year-label font-serif text-3xl text-primary/70 md:text-4xl">{group.year}</div>
              <div className="min-w-0 border-t border-outline-variant/50">
                {group.trips.map((trip, index) => {
                  const isConfirmingDelete = confirmingTripId === trip.id;
                  const isDeleting = deletingTripId === trip.id;
                  return (
                    <div
                      key={trip.id}
                      className="archive-entry group grid w-full gap-5 border-b border-outline-variant/50 py-5 text-left transition md:grid-cols-[210px_1fr_auto] md:items-center md:py-6"
                      onClick={() => selectTrip(trip.id, "tripDetail")}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectTrip(trip.id, "tripDetail");
                        }
                      }}
                      role="button"
                      style={{ "--archive-entry-delay": `${index * 80}ms` } as CSSProperties}
                      tabIndex={0}
                    >
                      <span className="archive-entry-media block h-40 w-full overflow-hidden rounded-lg bg-surface-container md:h-32">
                        <img src={trip.coverUrl} alt={tripLabel(trip)} className="h-full w-full object-cover" />
                      </span>

                      <span className="flex min-w-0 flex-col gap-4">
                        <span>
                          <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <h3 className="archive-entry-title font-serif text-2xl font-semibold leading-tight text-on-surface md:text-3xl">{tripLabel(trip)}</h3>
                          </span>
                          <span className="mt-3 block text-sm leading-6 text-on-surface-variant">
                            {trip.countries.map((country) => countryLabel(country, undefined, locale)).join(" / ")}
                          </span>
                        </span>

                        <span className="flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold text-outline">
                          <span className="inline-flex items-center gap-1.5"><CalendarDays size={14} /> {trip.dateRange.start} - {trip.dateRange.end}</span>
                          <span className="inline-flex items-center gap-1.5"><Image size={14} /> {trip.photoCount} {t("photoCount")}</span>
                          <span className="inline-flex items-center gap-1.5"><MapPin size={14} /> {trip.placeNodeCount} {t("placeCount")}</span>
                        </span>
                      </span>

                      <span className="archive-entry-action hidden md:grid">
                        {isConfirmingDelete ? (
                          <span className="archive-delete-confirm" onClick={(event) => event.stopPropagation()}>
                            <span>{t("confirmDeleteTrip")}</span>
                            <button
                              className="archive-delete-accept"
                              disabled={isDeleting}
                              onClick={() => void confirmDeleteTrip(trip.id)}
                              title={t("confirm")}
                              type="button"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              className="archive-delete-cancel"
                              disabled={isDeleting}
                              onClick={() => setConfirmingTripId(undefined)}
                              title={t("cancel")}
                              type="button"
                            >
                              <X size={13} />
                            </button>
                          </span>
                        ) : (
                          <button
                            className="archive-delete-trigger"
                            onClick={(event) => {
                              event.stopPropagation();
                              requestDeleteTrip(trip.id);
                            }}
                            title={t("deleteTrip")}
                            type="button"
                            aria-label={t("deleteTrip")}
                          >
                            <X size={18} />
                          </button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {trips.length === 0 ? (
            <div className="border-y border-outline-variant/50 py-12 text-sm text-on-surface-variant">
              {t("noTrips")}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
