import { ArrowLeft, LocateFixed, MapPin, PencilLine, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store/appStore";

export function TripDetailPanel() {
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const trips = useAppStore((state) => state.trips);
  const allPhotos = useAppStore((state) => state.photos);
  const allPlaces = useAppStore((state) => state.placeNodes);
  const allPendingItems = useAppStore((state) => state.pendingItems);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const updateTripTitle = useAppStore((state) => state.updateTripTitle);
  const updateTripDates = useAppStore((state) => state.updateTripDates);
  const updatePhotoMetadata = useAppStore((state) => state.updatePhotoMetadata);
  const selectPhoto = useAppStore((state) => state.selectPhoto);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const movePhotoToTrip = useAppStore((state) => state.movePhotoToTrip);
  const acknowledgePendingItem = useAppStore((state) => state.acknowledgePendingItem);
  const trip = trips.find((item) => item.id === selectedTripId);
  const [title, setTitle] = useState(trip?.title ?? "");
  const [start, setStart] = useState(trip?.dateRange.start ?? "");
  const [end, setEnd] = useState(trip?.dateRange.end ?? "");
  const [editingPhotoId, setEditingPhotoId] = useState<string>();
  const [openPhotoId, setOpenPhotoId] = useState<string>();
  const photos = allPhotos.filter((photo) => photo.tripId === selectedTripId);
  const places = allPlaces.filter((place) => place.tripId === selectedTripId);
  const pendingItems = allPendingItems.filter((item) => item.relatedTripId === selectedTripId && item.status === "open");

  const photosByDay = useMemo(() => {
    return photos.reduce<Record<string, typeof photos>>((groups, photo) => {
      const day = photo.capturedAt?.slice(0, 10) ?? "待补时间";
      groups[day] = [...(groups[day] ?? []), photo];
      return groups;
    }, {});
  }, [photos]);

  useEffect(() => {
    setTitle(trip?.title ?? "");
    setStart(trip?.dateRange.start ?? "");
    setEnd(trip?.dateRange.end ?? "");
  }, [trip?.dateRange.end, trip?.dateRange.start, trip?.title]);

  if (!trip) return null;

  return (
    <section className="fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 shadow-ambient backdrop-blur-2xl md:px-16 md:py-10">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex items-start justify-between gap-5">
          <button
            className="inline-flex items-center gap-2 rounded-full bg-white/70 px-4 py-2 text-sm font-semibold text-primary shadow-soft"
            onClick={() => setActivePanel("archive")}
            type="button"
          >
            <ArrowLeft size={16} /> 返回档案袋
          </button>
          <button
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/70 text-primary shadow-soft transition hover:bg-primary-fixed"
            aria-label="关闭档案详情"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-7 lg:grid-cols-[0.95fr_1.35fr]">
          <aside className="space-y-5">
            <div className="safe-panel rounded-[28px] p-6">
              <img src={trip.coverUrl} alt={trip.title} className="h-56 w-full rounded-[22px] object-cover" />
              <label className="mt-5 block">
                <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-outline">
                  <PencilLine size={14} /> Trip Name
                </span>
                <input
                  className="soft-input w-full text-2xl font-semibold text-primary outline-none"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  onBlur={() => updateTripTitle(trip.id, title)}
                />
              </label>
              <p className="mt-4 text-sm leading-6 text-on-surface-variant">
                {trip.dateRange.start} - {trip.dateRange.end} · {trip.cities.join(" / ")}
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <input className="soft-input text-sm outline-none" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
                <input className="soft-input text-sm outline-none" type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
                <button className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-white" onClick={() => updateTripDates(trip.id, start, end)} type="button">
                  更新日期
                </button>
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-2xl bg-surface-container-low p-3">
                  <p className="text-xl font-semibold text-primary">{photos.length}</p>
                  <p className="text-[11px] text-outline">照片</p>
                </div>
                <div className="rounded-2xl bg-surface-container-low p-3">
                  <p className="text-xl font-semibold text-secondary">{places.length}</p>
                  <p className="text-[11px] text-outline">地点</p>
                </div>
                <div className="rounded-2xl bg-surface-container-low p-3">
                  <p className="text-xl font-semibold text-tertiary">{pendingItems.length}</p>
                  <p className="text-[11px] text-outline">待确认</p>
                </div>
              </div>
            </div>

            <div className="safe-panel rounded-[28px] p-6">
              <h3 className="font-serif text-2xl font-semibold text-on-surface">地点节点</h3>
              <div className="mt-4 space-y-3">
                {places.map((place, index) => (
                  <button
                    key={place.id}
                    className="flex w-full items-center justify-between rounded-2xl bg-white/50 px-4 py-3 text-left transition hover:bg-primary-fixed/55"
                    onClick={() => selectPlace(place.id)}
                    type="button"
                  >
                    <span>
                      <span className="block text-sm font-semibold text-on-surface">{index + 1}. {place.name}</span>
                      <span className="text-xs text-outline">{place.photoIds.length} 张照片</span>
                    </span>
                    <LocateFixed size={16} className="text-primary" />
                  </button>
                ))}
              </div>
            </div>

            {pendingItems.length > 0 ? (
              <div className="ai-narrative-block rounded-[28px] p-6">
                <h3 className="font-serif text-2xl font-semibold text-primary">待确认</h3>
                <div className="mt-4 space-y-3">
                  {pendingItems.map((item) => (
                    <div key={item.id} className="rounded-2xl bg-white/48 p-4">
                      <p className="text-sm font-semibold text-on-surface">{item.suggestion}</p>
                      <p className="mt-2 text-xs leading-5 text-on-surface-variant">{item.reason}</p>
                      <div className="mt-3 flex gap-2">
                        <button className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white" onClick={() => acknowledgePendingItem(item.id, true)} type="button">确认</button>
                        <button className="rounded-full bg-white/70 px-3 py-1.5 text-xs font-semibold text-primary" onClick={() => acknowledgePendingItem(item.id, false)} type="button">忽略</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>

          <div className="space-y-8">
            {Object.entries(photosByDay).map(([day, dayPhotos]) => (
              <section key={day}>
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-px flex-1 bg-outline-variant" />
                  <h3 className="font-serif text-2xl font-semibold text-primary">{day}</h3>
                  <div className="h-px flex-1 bg-outline-variant" />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {dayPhotos.map((photo) => (
                    <article key={photo.id} className="overflow-hidden rounded-[18px] bg-white/70 shadow-soft transition hover:-translate-y-0.5 hover:shadow-float">
                      <button className="block w-full text-left" onClick={() => setOpenPhotoId(photo.id)} type="button">
                        <img src={photo.thumbnailUrl} alt={photo.title ?? photo.aiCaption} className="h-52 w-full object-cover" />
                        <div className="px-4 py-3">
                          <p className="truncate text-sm font-semibold text-on-surface">{photo.title ?? photo.fileName}</p>
                        </div>
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
      {openPhotoId ? (
        <PhotoDetailModal
          photo={photos.find((photo) => photo.id === openPhotoId)}
          editing={editingPhotoId === openPhotoId}
          onClose={() => {
            setOpenPhotoId(undefined);
            setEditingPhotoId(undefined);
          }}
          onLocate={(photoId) => {
            selectPhoto(photoId);
            setOpenPhotoId(undefined);
            setActivePanel("globe");
          }}
          onRemove={(photoId) => {
            void movePhotoToTrip(photoId, undefined);
            setOpenPhotoId(undefined);
          }}
          onToggleEdit={(photoId) => setEditingPhotoId(editingPhotoId === photoId ? undefined : photoId)}
          onSave={(photoId, capturedAt, lat, lng, tags) => {
            void updatePhotoMetadata(photoId, capturedAt, lat, lng, tags);
            setEditingPhotoId(undefined);
          }}
        />
      ) : null}
    </section>
  );
}

function PhotoDetailModal({
  photo,
  editing,
  onClose,
  onLocate,
  onRemove,
  onToggleEdit,
  onSave,
}: {
  photo?: {
    id: string;
    title?: string;
    fileName: string;
    storageUrl?: string;
    thumbnailUrl: string;
    aiCaption: string;
    tags: string[];
    capturedAt?: string;
    location?: { lat: number; lng: number };
    exifStatus?: { time: string; gps: string };
    pendingReason?: string;
  };
  editing: boolean;
  onClose: () => void;
  onLocate: (photoId: string) => void;
  onRemove: (photoId: string) => void;
  onToggleEdit: (photoId: string) => void;
  onSave: (photoId: string, capturedAt: string, lat: string, lng: string, tags: string) => void;
}) {
  if (!photo) return null;

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center bg-surface/35 px-4 py-8 backdrop-blur-xl" onMouseDown={onClose}>
      <article
        className="max-h-[86vh] w-[min(980px,calc(100vw-32px))] overflow-hidden rounded-[24px] bg-white/92 shadow-float"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="grid md:grid-cols-[1.08fr_0.92fr]">
          <div className="bg-surface-container-low">
            <img src={photo.storageUrl ?? photo.thumbnailUrl} alt={photo.title ?? photo.aiCaption} className="h-[42vh] min-h-[320px] w-full object-contain md:h-[68vh]" />
          </div>
          <div className="max-h-[68vh] overflow-y-auto p-6 md:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-outline">{photo.capturedAt?.slice(0, 10) ?? "待补时间"}</p>
                <h3 className="mt-2 font-serif text-3xl font-semibold text-primary">{photo.title ?? photo.fileName}</h3>
              </div>
              <button className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-container-low text-primary" onClick={onClose} type="button" aria-label="关闭照片详情">
                <X size={17} />
              </button>
            </div>

            <p className="mt-5 text-sm leading-7 text-on-surface-variant">{photo.aiCaption}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {photo.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-primary-fixed/70 px-3 py-1.5 text-xs font-semibold text-primary">{tag}</span>
              ))}
              {photo.pendingReason ? <span className="rounded-full bg-tertiary-fixed px-3 py-1.5 text-xs font-semibold text-tertiary">待确认</span> : null}
            </div>

            <div className="mt-6 grid grid-cols-3 gap-3">
              <button className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-3 text-sm font-semibold text-primary shadow-soft" onClick={() => onLocate(photo.id)} type="button">
                <MapPin size={16} /> 定位
              </button>
              <button className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-3 text-sm font-semibold text-outline shadow-soft" onClick={() => onRemove(photo.id)} type="button">
                <Trash2 size={16} /> 移除
              </button>
              <button className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-3 text-sm font-semibold text-primary shadow-soft" onClick={() => onToggleEdit(photo.id)} type="button">
                <PencilLine size={16} /> 修改
              </button>
            </div>

            {editing ? (
              <PhotoMetadataEditor
                photo={photo}
                onSave={(capturedAt, lat, lng, tags) => onSave(photo.id, capturedAt, lat, lng, tags)}
              />
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}

function toLocalDateTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

function PhotoMetadataEditor({
  photo,
  onSave,
}: {
  photo: { capturedAt?: string; location?: { lat: number; lng: number }; tags: string[]; exifStatus?: { time: string; gps: string } };
  onSave: (capturedAt: string, lat: string, lng: string, tags: string) => void;
}) {
  const [capturedAt, setCapturedAt] = useState(toLocalDateTime(photo.capturedAt));
  const [lat, setLat] = useState(photo.location?.lat.toFixed(6) ?? "");
  const [lng, setLng] = useState(photo.location?.lng.toFixed(6) ?? "");
  const [tags, setTags] = useState(photo.tags.join(" "));

  return (
    <div className="mt-4 border-t border-outline-variant pt-4">
      <div className="grid gap-2">
        <input className="soft-input text-xs outline-none" type="datetime-local" value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input className="soft-input text-xs outline-none" placeholder="Latitude" value={lat} onChange={(event) => setLat(event.target.value)} />
          <input className="soft-input text-xs outline-none" placeholder="Longitude" value={lng} onChange={(event) => setLng(event.target.value)} />
        </div>
        <input className="soft-input text-xs outline-none" placeholder="标签，用空格或逗号分隔" value={tags} onChange={(event) => setTags(event.target.value)} />
        <p className="text-[11px] text-outline">EXIF：时间 {photo.exifStatus?.time ?? "unknown"} · GPS {photo.exifStatus?.gps ?? "unknown"}</p>
        <button className="w-fit rounded-full bg-primary px-4 py-2 text-xs font-semibold text-white" onClick={() => onSave(capturedAt, lat, lng, tags)} type="button">
          保存照片信息
        </button>
      </div>
    </div>
  );
}
