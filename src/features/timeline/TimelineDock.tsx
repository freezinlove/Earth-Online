import { clsx } from "clsx";
import { Minus, Plus } from "lucide-react";
import { useMemo } from "react";
import { useAppStore } from "@/store/appStore";

function timeValue(date?: string) {
  const value = date ? new Date(date).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

function percent(value: number, min: number, max: number) {
  if (max <= min) return 50;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

function dayKey(date?: string) {
  return date?.slice(0, 10) ?? "待确认";
}

export function TimelineDock() {
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const selectedPhotoId = useAppStore((state) => state.selectedPhotoId);
  const cursorDate = useAppStore((state) => state.cursorDate);
  const zoom = useAppStore((state) => state.timelineZoom);
  const segments = useAppStore((state) => state.timelineSegments);
  const photos = useAppStore((state) => state.photos);
  const trips = useAppStore((state) => state.trips);
  const selectTrip = useAppStore((state) => state.selectTrip);
  const selectPhoto = useAppStore((state) => state.selectPhoto);
  const setCursorDate = useAppStore((state) => state.setCursorDate);
  const setTimelineZoom = useAppStore((state) => state.setTimelineZoom);

  const selectedTrip = trips.find((trip) => trip.id === selectedTripId);
  const tripPhotos = useMemo(
    () => photos.filter((photo) => photo.tripId === selectedTripId && photo.capturedAt).sort((a, b) => timeValue(a.capturedAt) - timeValue(b.capturedAt)),
    [photos, selectedTripId],
  );
  const activePhoto = tripPhotos.find((photo) => photo.id === selectedPhotoId) ?? tripPhotos.find((photo) => dayKey(photo.capturedAt) === cursorDate) ?? tripPhotos[0];
  const activeTime = timeValue(activePhoto?.capturedAt ?? selectedTrip?.dateRange.start ?? cursorDate);

  const domain = useMemo(() => {
    if (zoom === "global") {
      const times = segments.flatMap((segment) => [timeValue(segment.start), timeValue(segment.end)]).filter(Boolean);
      return { min: Math.min(...times, activeTime), max: Math.max(...times, activeTime) };
    }
    if (zoom === "day") {
      const sameDay = tripPhotos.filter((photo) => dayKey(photo.capturedAt) === cursorDate);
      const source = sameDay.length ? sameDay : tripPhotos;
      const times = source.map((photo) => timeValue(photo.capturedAt)).filter(Boolean);
      return { min: Math.min(...times, activeTime), max: Math.max(...times, activeTime) };
    }
    const times = tripPhotos.map((photo) => timeValue(photo.capturedAt)).filter(Boolean);
    return { min: Math.min(...times, timeValue(selectedTrip?.dateRange.start)), max: Math.max(...times, timeValue(selectedTrip?.dateRange.end)) };
  }, [activeTime, cursorDate, segments, selectedTrip?.dateRange.end, selectedTrip?.dateRange.start, tripPhotos, zoom]);

  const dayGroups = useMemo(() => {
    const map = new Map<string, number>();
    for (const photo of tripPhotos) map.set(dayKey(photo.capturedAt), (map.get(dayKey(photo.capturedAt)) ?? 0) + 1);
    return Array.from(map.entries()).map(([day, count]) => ({ day, count, time: timeValue(day) }));
  }, [tripPhotos]);

  const activePosition = percent(activeTime, domain.min, domain.max);

  const focusNearest = (nextPercent: number) => {
    const target = domain.min + (nextPercent / 100) * (domain.max - domain.min);
    if (zoom === "global") {
      const nearest = segments
        .map((segment) => ({ segment, distance: Math.abs(timeValue(segment.start) - target) }))
        .sort((a, b) => a.distance - b.distance)[0]?.segment;
      if (nearest) {
        selectTrip(nearest.relatedId);
        setCursorDate(nearest.start);
      }
      return;
    }
    const candidates = zoom === "day" ? tripPhotos.filter((photo) => dayKey(photo.capturedAt) === cursorDate) : tripPhotos;
    const nearestPhoto = candidates.map((photo) => ({ photo, distance: Math.abs(timeValue(photo.capturedAt) - target) })).sort((a, b) => a.distance - b.distance)[0]?.photo;
    if (nearestPhoto) selectPhoto(nearestPhoto.id);
  };

  return (
    <section
      className="fixed bottom-[6.25rem] left-1/2 z-40 w-[min(940px,calc(100vw-28px))] -translate-x-1/2 px-1 md:bottom-7 md:w-[min(960px,calc(100vw-320px))] xl:w-[min(980px,60vw)]"
      aria-label="旅行时间轴"
    >
      <div className="timeline-paper-dock rounded-[28px] px-5 py-4 backdrop-blur-2xl md:rounded-[28px] md:px-7 md:py-5">
        <div className="mb-3 flex items-center justify-between gap-4 px-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-outline">Timeline</p>
            <p className="mt-1 text-sm font-semibold text-primary">
              {zoom === "global" ? `${segments.length} 段旅行` : activePhoto ? `${dayKey(activePhoto.capturedAt)} · ${activePhoto.title ?? activePhoto.fileName}` : cursorDate}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="grid h-9 w-9 place-items-center rounded-full bg-white/68 text-primary shadow-soft"
              type="button"
              aria-label="缩小时间范围"
              onClick={() => setTimelineZoom(zoom === "day" ? "trip" : "global")}
            >
              <Minus size={16} />
            </button>
            <span className="min-w-14 text-center text-xs font-semibold text-on-surface-variant">{zoom === "global" ? "年/月" : zoom === "trip" ? "天" : "照片"}</span>
            <button
              className="grid h-9 w-9 place-items-center rounded-full bg-white/68 text-primary shadow-soft"
              type="button"
              aria-label="放大时间范围"
              onClick={() => setTimelineZoom(zoom === "global" ? "trip" : "day")}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        <div className="relative h-24 overflow-hidden px-2">
          <div className="absolute left-2 right-2 top-[42px] h-px bg-outline-variant/80" />
          <div className="absolute top-[29px] z-20 h-7 w-7 -translate-x-1/2 rounded-full bg-primary shadow-float ring-[5px] ring-white transition-[left]" style={{ left: `${activePosition}%` }}>
            <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
          </div>

          {zoom === "global"
            ? segments.map((segment) => {
                const left = percent(timeValue(segment.start), domain.min, domain.max);
                const width = Math.max(2, percent(timeValue(segment.end), domain.min, domain.max) - left);
                const active = segment.relatedId === selectedTripId;
                return (
                  <button
                    key={segment.id}
                    className={clsx("absolute top-8 h-5 rounded-full transition", active ? "bg-primary shadow-soft" : "bg-primary-fixed hover:bg-secondary-container")}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    onClick={() => {
                      selectTrip(segment.relatedId);
                      setCursorDate(segment.start);
                    }}
                    type="button"
                    aria-label={segment.label}
                  >
                    <span className="absolute left-0 top-7 max-w-32 truncate text-left text-[11px] font-semibold text-primary">{segment.label}</span>
                  </button>
                );
              })
            : null}

          {zoom !== "global"
            ? dayGroups.map((group) => (
                <button
                  key={group.day}
                  className={clsx("absolute top-[33px] w-2 -translate-x-1/2 rounded-full transition", group.day === cursorDate ? "h-9 bg-primary" : "h-5 bg-outline-variant hover:bg-primary")}
                  style={{ left: `${percent(group.time, domain.min, domain.max)}%` }}
                  onClick={() => {
                    setCursorDate(group.day);
                    const first = tripPhotos.find((photo) => dayKey(photo.capturedAt) === group.day);
                    if (first) selectPhoto(first.id);
                  }}
                  type="button"
                  aria-label={`${group.day} ${group.count} 张照片`}
                />
              ))
            : null}

          {zoom !== "global"
            ? tripPhotos.map((photo) => (
                <button
                  key={photo.id}
                  className={clsx("absolute top-[39px] h-3 w-3 -translate-x-1/2 rounded-full transition", photo.id === selectedPhotoId ? "bg-tertiary ring-4 ring-white" : "bg-white shadow-soft hover:bg-tertiary")}
                  style={{ left: `${percent(timeValue(photo.capturedAt), domain.min, domain.max)}%` }}
                  onClick={() => selectPhoto(photo.id)}
                  type="button"
                  aria-label={photo.fileName}
                />
              ))
            : null}
        </div>

        <input
          className="mt-1 w-full accent-primary"
          type="range"
          min={0}
          max={100}
          step={1}
          value={activePosition}
          onChange={(event) => focusNearest(Number(event.target.value))}
          aria-label="拖动时间光标"
        />
      </div>
    </section>
  );
}
