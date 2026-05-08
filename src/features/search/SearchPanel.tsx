import { LocateFixed, Search, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { capturedDateLabel } from "@/domain/datetime";
import { photoAltText, photoLabel, placeLabel, tripLabel } from "@/domain/labels";
import { useAppStore } from "@/store/appStore";

export function SearchPanel() {
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const selectPhoto = useAppStore((state) => state.selectPhoto);
  const query = useAppStore((state) => state.searchQuery);
  const setQuery = useAppStore((state) => state.setSearchQuery);
  const runSearch = useAppStore((state) => state.runSearch);
  const searchResults = useAppStore((state) => state.searchResults);
  const filters = useAppStore((state) => state.searchFilters);
  const setFilters = useAppStore((state) => state.setSearchFilters);
  const photos = useAppStore((state) => state.photos);
  const trips = useAppStore((state) => state.trips);
  const places = useAppStore((state) => state.placeNodes);

  useEffect(() => {
    void runSearch();
  }, [runSearch]);

  const results = useMemo(() => {
    return searchResults
      .map((result) => {
        const photo = photos.find((item) => item.id === result.photoId);
        const trip = trips.find((item) => item.id === result.tripId);
        return photo ? { photo, trip, score: result.score, reason: result.reason } : undefined;
      })
      .filter((result): result is NonNullable<typeof result> => Boolean(result))
      .slice(0, 12);
  }, [photos, searchResults, trips]);

  return (
    <section className="fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.34em] text-outline">AI Memory Search</p>
            <h2 className="mt-2 font-serif text-4xl font-semibold text-primary md:text-5xl">记忆搜索</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-on-surface-variant">
              MVP 搜索通过后端 Search Service：基础元数据过滤、Qwen 标签与本地向量索引都会参与匹配。点击结果会同步定位地球和时间轴。
            </p>
          </div>
          <button
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/70 text-primary shadow-soft transition hover:bg-primary-fixed"
            aria-label="关闭搜索"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <label className="safe-panel flex items-center gap-3 rounded-[28px] px-5 py-4">
          <Search size={20} className="shrink-0 text-outline" />
          <input
            className="soft-input w-full bg-transparent text-lg text-on-surface outline-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="找京都夜景、海边日落、某段旅行里的美食..."
          />
        </label>

        <div className="mt-4 grid gap-3 rounded-[24px] bg-white/55 p-4 md:grid-cols-5">
          <select className="soft-input text-sm outline-none" value={filters.tripId ?? ""} onChange={(event) => setFilters({ ...filters, tripId: event.target.value || undefined, placeId: undefined })}>
            <option value="">全部旅行</option>
            {trips.map((trip) => (
              <option key={trip.id} value={trip.id}>{tripLabel(trip)}</option>
            ))}
          </select>
          <select className="soft-input text-sm outline-none" value={filters.placeId ?? ""} onChange={(event) => setFilters({ ...filters, placeId: event.target.value || undefined })}>
            <option value="">全部地点</option>
            {places
              .filter((place) => !filters.tripId || place.tripId === filters.tripId)
              .map((place) => (
                <option key={place.id} value={place.id}>{placeLabel(place)}</option>
              ))}
          </select>
          <input className="soft-input text-sm outline-none" type="date" value={filters.date ?? ""} onChange={(event) => setFilters({ ...filters, date: event.target.value || undefined })} />
          <input className="soft-input text-sm outline-none" placeholder="标签" value={filters.tag ?? ""} onChange={(event) => setFilters({ ...filters, tag: event.target.value || undefined })} />
          <input className="soft-input text-sm outline-none" placeholder="文件名" value={filters.fileName ?? ""} onChange={(event) => setFilters({ ...filters, fileName: event.target.value || undefined })} />
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {results.map(({ photo, trip, reason }) => (
            <button
              key={photo.id}
              className="overflow-hidden rounded-[24px] bg-white/72 text-left shadow-soft transition hover:-translate-y-0.5 hover:shadow-float"
              onClick={() => selectPhoto(photo.id)}
              type="button"
            >
              <img src={photo.thumbnailUrl} alt={photoAltText(photo)} className="h-44 w-full object-cover" />
              <div className="p-5">
                <p className="font-serif text-xl font-semibold">{photo.title ? photoLabel(photo) : tripLabel(trip)}</p>
                <p className="mt-1 text-xs text-outline">{capturedDateLabel(photo.capturedAt)} · {photo.tags.join(" / ")}</p>
                <p className="mt-3 text-sm leading-6 text-on-surface-variant">{reason || photo.aiCaption}</p>
                <span className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary-fixed px-3 py-1.5 text-xs font-semibold text-primary">
                  <LocateFixed size={14} /> 定位到地球与时间轴
                </span>
              </div>
            </button>
          ))}
          {results.length === 0 ? (
            <div className="ai-narrative-block rounded-[24px] p-6 text-sm leading-6 text-on-surface-variant md:col-span-2">
              没找到匹配的记忆。可以换一个地点、时间、照片标签或更具体的画面描述。
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
