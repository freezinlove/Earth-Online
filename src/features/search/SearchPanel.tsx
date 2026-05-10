import { Archive, LocateFixed, Search, X } from "lucide-react";
import { useEffect, useMemo, type CSSProperties } from "react";
import { placeFocusIntent } from "@/domain/globeIntent";
import { photoAltText, photoLabel } from "@/domain/labels";
import { useI18n } from "@/i18n/useI18n";
import { useAppStore } from "@/store/appStore";

export function SearchPanel({ isClosing = false }: { isClosing?: boolean }) {
  const { t } = useI18n();
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const selectTrip = useAppStore((state) => state.selectTrip);
  const focusPlaceOnGlobe = useAppStore((state) => state.focusPlaceOnGlobe);
  const query = useAppStore((state) => state.searchQuery);
  const setQuery = useAppStore((state) => state.setSearchQuery);
  const runSearch = useAppStore((state) => state.runSearch);
  const searchResults = useAppStore((state) => state.searchResults);
  const filters = useAppStore((state) => state.searchFilters);
  const setFilters = useAppStore((state) => state.setSearchFilters);
  const photos = useAppStore((state) => state.photos);
  const trips = useAppStore((state) => state.trips);
  const places = useAppStore((state) => state.placeNodes);
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    if (Object.keys(filters).length > 0) setFilters({});
  }, [filters, setFilters]);

  useEffect(() => {
    if (hasQuery) void runSearch();
  }, [hasQuery, runSearch]);

  const results = useMemo(() => {
    if (!hasQuery) return [];
    return searchResults
      .map((result) => {
        const photo = photos.find((item) => item.id === result.photoId);
        const trip = trips.find((item) => item.id === result.tripId);
        const place = photo?.placeNodeId ? places.find((item) => item.id === photo.placeNodeId) : undefined;
        return photo ? { photo, place, trip } : undefined;
      })
      .filter((result): result is NonNullable<typeof result> => Boolean(result))
      .slice(0, 12);
  }, [hasQuery, photos, places, searchResults, trips]);

  const locatePhoto = (photoId: string, placeId?: string) => {
    const place = placeId ? places.find((item) => item.id === placeId) : undefined;
    if (place) {
      focusPlaceOnGlobe(place.id, placeFocusIntent(place));
      return;
    }

    const photo = photos.find((item) => item.id === photoId);
    if (photo?.tripId) selectTrip(photo.tripId, "globe");
    else setActivePanel("globe");
  };

  return (
    <section className="search-panel fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12" data-state={isClosing ? "closing" : "open"}>
      <button className="search-close" aria-label={t("closeSearch")} onClick={() => setActivePanel("globe")} type="button">
        <X size={22} />
      </button>

      <div className="search-bar-wrap">
        <label className="search-input-shell">
          <Search size={20} className="shrink-0 text-outline" />
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("searchPhotos")}
            placeholder={t("searchPlaceholder")}
            autoFocus
          />
        </label>
      </div>

      <div className="search-shell mx-auto max-w-6xl">
        {hasQuery && results.length > 0 ? (
          <div className="search-results">
            {results.map(({ photo, place, trip }, index) => (
            <article
              key={photo.id}
              className="search-result"
              style={{ "--search-result-delay": `${index * 70}ms` } as CSSProperties}
            >
              <img src={photo.thumbnailUrl} alt={photoAltText(photo)} />
              <div className="search-result-copy">
                <h3>{photoLabel(photo)}</h3>
                <div className="search-result-actions">
                  <button onClick={() => locatePhoto(photo.id, place?.id)} type="button" aria-label={t("locate")} title={t("locate")}>
                    <LocateFixed size={17} />
                  </button>
                  <button disabled={!trip} onClick={() => trip && selectTrip(trip.id, "tripDetail")} type="button" aria-label={t("openArchive")} title={t("openArchive")}>
                    <Archive size={17} />
                  </button>
                </div>
              </div>
            </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
