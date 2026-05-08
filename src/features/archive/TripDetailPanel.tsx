import { ArrowLeft, CalendarDays, Image, MapPin, PencilLine, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { Photo, PlaceNode } from "@/domain/models";
import { useAppStore } from "@/store/appStore";

type DayGroup = {
  country: string;
  day: string;
  photos: Photo[];
  places: PlaceNode[];
};

type CountryGroup = {
  country: string;
  days: DayGroup[];
};

function formatDay(day: string) {
  return day === "待补时间" ? day : day.replace(/-/g, ".");
}

function getPhotoSource(photo?: Photo) {
  return getHighResolutionSource(photo?.storageUrl ?? photo?.thumbnailUrl ?? "");
}

function getHighResolutionSource(source: string, width = 1800) {
  if (!source.includes("images.unsplash.com")) return source;

  return source
    .replace(/([?&]w=)\d+/g, (_match, prefix: string) => `${prefix}${width}`)
    .replace(/([?&]q=)\d+/g, (_match, prefix: string) => `${prefix}90`);
}

function getRouteLabel(group: DayGroup) {
  return group.places[0]?.name ?? "未标地点";
}

function getRoutePlace(group: DayGroup) {
  return group.places[0];
}

const placeCountryHints: Record<string, string> = {
  巴黎: "法国",
  卢塞恩: "瑞士",
  佛罗伦萨: "意大利",
  大阪: "日本",
  京都: "日本",
  奈良: "日本",
  成都: "中国",
  康定: "中国",
  理塘: "中国",
  布拉格: "捷克",
  维也纳: "奥地利",
  哈尔施塔特: "奥地利",
  萨尔茨堡: "奥地利",
  布达佩斯: "匈牙利",
  加米施: "德国",
  艾布湖: "德国",
};

function inferCountry(group: { photos: Photo[]; places: PlaceNode[] }, countries: string[], fallback: string) {
  const text = [
    ...group.places.map((place) => place.name),
    ...group.photos.flatMap((photo) => [photo.title, photo.fileName, photo.aiCaption, ...photo.tags]),
  ]
    .filter(Boolean)
    .join(" ");

  const direct = countries.find((country) => text.includes(country));
  if (direct) return direct;

  const hint = Object.entries(placeCountryHints).find(([keyword, country]) => text.includes(keyword) && countries.includes(country));
  return hint?.[1] ?? fallback;
}

export function TripDetailPanel() {
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const trips = useAppStore((state) => state.trips);
  const allPhotos = useAppStore((state) => state.photos);
  const allPlaces = useAppStore((state) => state.placeNodes);
  const allPendingItems = useAppStore((state) => state.pendingItems);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const updateTripTitle = useAppStore((state) => state.updateTripTitle);
  const updatePhotoMetadata = useAppStore((state) => state.updatePhotoMetadata);
  const selectPhoto = useAppStore((state) => state.selectPhoto);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const movePhotoToTrip = useAppStore((state) => state.movePhotoToTrip);
  const acknowledgePendingItem = useAppStore((state) => state.acknowledgePendingItem);
  const trip = trips.find((item) => item.id === selectedTripId);
  const [title, setTitle] = useState(trip?.title ?? "");
  const [editingPhotoId, setEditingPhotoId] = useState<string>();
  const [openPhotoId, setOpenPhotoId] = useState<string>();
  const photos = useMemo(
    () => allPhotos.filter((photo) => photo.tripId === selectedTripId).sort((left, right) => (left.capturedAt ?? "").localeCompare(right.capturedAt ?? "")),
    [allPhotos, selectedTripId],
  );
  const places = useMemo(() => allPlaces.filter((place) => place.tripId === selectedTripId), [allPlaces, selectedTripId]);
  const placeById = useMemo(() => new Map(places.map((place) => [place.id, place])), [places]);
  const pendingItems = allPendingItems.filter((item) => item.relatedTripId === selectedTripId && item.status === "open");
  const tripCountries = useMemo(() => trip?.countries ?? [], [trip?.countries]);

  const dayGroups = useMemo<DayGroup[]>(() => {
    const groups = photos.reduce<Record<string, Photo[]>>((result, photo) => {
      const day = photo.capturedAt?.slice(0, 10) ?? "待补时间";
      result[day] = [...(result[day] ?? []), photo];
      return result;
    }, {});

    return Object.entries(groups)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, dayPhotos], groupIndex) => {
        const dayPlaces = dayPhotos
          .map((photo) => (photo.placeNodeId ? placeById.get(photo.placeNodeId) : undefined))
          .filter((place): place is PlaceNode => Boolean(place))
          .filter((place, index, list) => list.findIndex((item) => item.id === place.id) === index);

        const fallbackCountry = tripCountries[Math.min(groupIndex, tripCountries.length - 1)] ?? tripCountries[0] ?? "未标国家";
        const country = inferCountry({ photos: dayPhotos, places: dayPlaces }, tripCountries, fallbackCountry);

        return { country, day, photos: dayPhotos, places: dayPlaces };
      });
  }, [photos, placeById, tripCountries]);

  const countryGroups = useMemo<CountryGroup[]>(() => {
    return dayGroups.reduce<CountryGroup[]>((groups, day) => {
      const current = groups[groups.length - 1];
      if (current?.country === day.country) {
        current.days.push(day);
      } else {
        groups.push({ country: day.country, days: [day] });
      }
      return groups;
    }, []);
  }, [dayGroups]);

  useEffect(() => {
    setTitle(trip?.title ?? "");
  }, [trip?.title]);

  if (!trip) return null;

  const heroPhoto = getPhotoSource(photos[0]) || getHighResolutionSource(trip.coverUrl, 2200);

  return (
    <section className="trip-dossier fixed inset-0 z-[70] overflow-y-auto bg-background/94 backdrop-blur-2xl">
      <TripDossierBackButton onBack={() => setActivePanel("archive")} />

      <header className="trip-dossier-hero">
        <img src={heroPhoto} alt={trip.title} className="trip-dossier-hero-image" />
        <div className="trip-dossier-hero-copy">
          <p className="text-xs font-semibold uppercase tracking-[0.34em] text-white/72">Travel Dossier</p>
          <label className="mt-4 block max-w-4xl">
            <span className="sr-only">旅行标题</span>
            <textarea
              className="trip-dossier-title-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => updateTripTitle(trip.id, title)}
              rows={2}
            />
          </label>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-semibold text-white/78">
            <span className="inline-flex items-center gap-2"><CalendarDays size={15} /> {trip.dateRange.start} - {trip.dateRange.end}</span>
            <span className="inline-flex items-center gap-2"><Image size={15} /> {photos.length} 张照片</span>
            <span className="inline-flex items-center gap-2"><MapPin size={15} /> {places.length} 个地点</span>
          </div>
        </div>
      </header>

      <main className="trip-dossier-body mx-auto max-w-[1760px] px-5 pb-20 pt-8 md:px-10">
        {pendingItems.length > 0 ? (
          <section className="trip-dossier-pending">
            {pendingItems.map((item) => (
              <div key={item.id}>
                <p>{item.suggestion}</p>
                <span>{item.reason}</span>
                <button onClick={() => acknowledgePendingItem(item.id, true)} type="button">确认</button>
                <button onClick={() => acknowledgePendingItem(item.id, false)} type="button">忽略</button>
              </div>
            ))}
          </section>
        ) : null}

        <div className="trip-timeline">
          {countryGroups.map((countryGroup, countryIndex) => (
            <section key={`${countryGroup.country}-${countryIndex}`} className="trip-country-section">
              <div className="trip-country-column">
                <span>{countryGroup.country}</span>
              </div>

              <div className="trip-country-days">
                {countryGroup.days.map((group, groupIndex) => (
                  <section
                    key={group.day}
                    className="trip-day-section"
                    style={{ "--trip-day-delay": `${(countryIndex + groupIndex) * 90}ms` } as CSSProperties}
                  >
                    <div className="trip-route-column">
                      <span className="trip-route-dot" />
                      {getRoutePlace(group) ? (
                        <button className="trip-route-label" onClick={() => selectPlace(getRoutePlace(group)!.id)} type="button">
                          {getRouteLabel(group)}
                        </button>
                      ) : (
                        <span className="trip-route-label">{getRouteLabel(group)}</span>
                      )}
                    </div>

                    <div className="trip-day-content">
                      <div className="trip-day-marker">
                        <h3>{formatDay(group.day)}</h3>
                        <div className="h-px flex-1 bg-outline-variant/70" />
                      </div>

                      <div className="trip-photo-flow">
                        {group.photos.map((photo, index) => {
                          const place = photo.placeNodeId ? placeById.get(photo.placeNodeId) : undefined;
                          return (
                            <article key={photo.id} className={index === 0 ? "trip-photo-piece trip-photo-piece-featured" : "trip-photo-piece"}>
                              <button className="block w-full text-left" onClick={() => setOpenPhotoId(photo.id)} type="button">
                                <img src={getPhotoSource(photo)} alt={photo.title ?? photo.aiCaption} />
                                <span className="trip-photo-caption">
                                  <strong>{place?.name ?? photo.title ?? photo.fileName}</strong>
                                  <em>{photo.capturedAt?.slice(11, 16) ?? photo.fileName}</em>
                                </span>
                              </button>
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  </section>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>

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

function TripDossierBackButton({ onBack }: { onBack: () => void }) {
  return createPortal(
    <div className="trip-dossier-actions">
      <button className="trip-dossier-link" aria-label="返回档案袋" onClick={onBack} title="返回档案袋" type="button">
        <ArrowLeft size={30} />
      </button>
    </div>,
    document.body,
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

  return createPortal(
    <div className="trip-photo-modal" onMouseDown={onClose}>
      <article
        className="trip-photo-modal-shell"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="trip-photo-modal-media">
          <img src={getHighResolutionSource(photo.storageUrl ?? photo.thumbnailUrl, 2200)} alt={photo.title ?? photo.aiCaption} />
        </div>
        <div className="trip-photo-modal-copy">
          <div className="trip-photo-modal-heading">
            <div>
              <p>{photo.capturedAt?.slice(0, 10) ?? "待补时间"}</p>
              <h3>{photo.title ?? photo.fileName}</h3>
            </div>
            <button className="trip-photo-modal-close" onClick={onClose} type="button" aria-label="关闭照片详情">
              <X size={17} />
            </button>
          </div>

          <p className="trip-photo-modal-caption">{photo.aiCaption}</p>
          <div className="trip-photo-modal-tags">
            {photo.tags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
            {photo.pendingReason ? <span>待确认</span> : null}
          </div>

          <div className="trip-photo-modal-actions">
            <button onClick={() => onLocate(photo.id)} type="button">
              <MapPin size={16} /> 定位
            </button>
            <button onClick={() => onRemove(photo.id)} type="button">
              <Trash2 size={16} /> 移除
            </button>
            <button onClick={() => onToggleEdit(photo.id)} type="button">
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
      </article>
    </div>,
    document.body,
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
