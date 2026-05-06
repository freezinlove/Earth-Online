import { ArrowDown, ArrowUp, Link2, MapPinned, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "@/store/appStore";

export function ManualEditorPanel() {
  const trips = useAppStore((state) => state.trips);
  const photos = useAppStore((state) => state.photos);
  const places = useAppStore((state) => state.placeNodes);
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const createManualTrip = useAppStore((state) => state.createManualTrip);
  const addManualPlace = useAppStore((state) => state.addManualPlace);
  const deleteManualPlace = useAppStore((state) => state.deleteManualPlace);
  const reorderTripPlaces = useAppStore((state) => state.reorderTripPlaces);
  const bindPhotoToPlace = useAppStore((state) => state.bindPhotoToPlace);
  const [title, setTitle] = useState("新的旅行档案");
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(new Date().toISOString().slice(0, 10));
  const [placeName, setPlaceName] = useState("手动标记地点");
  const [lat, setLat] = useState(35.0116);
  const [lng, setLng] = useState(135.7681);
  const tripPlaces = places.filter((place) => place.tripId === selectedTripId);
  const unboundPhotos = photos.filter((photo) => photo.tripId === selectedTripId && !photo.placeNodeId);
  const movePlace = (index: number, direction: -1 | 1) => {
    const next = tripPlaces.map((place) => place.id);
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void reorderTripPlaces(selectedTripId, next);
  };

  return (
    <section className="fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 flex items-start justify-between gap-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.34em] text-outline">Manual Recovery Loop</p>
            <h2 className="mt-2 font-serif text-4xl font-semibold text-primary md:text-5xl">手动整理</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-on-surface-variant">
              即使没有 AI 或 GPS，也可以手动创建 Trip、标记地点、把照片绑定到地点，并生成基础路线。
            </p>
          </div>
          <button
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/70 text-primary shadow-soft transition hover:bg-primary-fixed"
            aria-label="关闭手动整理"
            onClick={() => setActivePanel("globe")}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="safe-panel rounded-[28px] p-6 md:p-8">
            <h3 className="font-serif text-2xl font-semibold text-on-surface">创建旅行档案</h3>
            <div className="mt-5 grid gap-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-outline">名称</span>
                <input className="soft-input mt-2 w-full outline-none" value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-outline">开始</span>
                  <input className="soft-input mt-2 w-full outline-none" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-outline">结束</span>
                  <input className="soft-input mt-2 w-full outline-none" type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
                </label>
              </div>
              <button className="inline-flex w-fit items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white shadow-soft" onClick={() => void createManualTrip(title, start, end)} type="button">
                <Plus size={17} /> 新建 Trip
              </button>
            </div>
          </div>

          <div className="safe-panel rounded-[28px] p-6 md:p-8">
            <h3 className="font-serif text-2xl font-semibold text-on-surface">创建地点节点</h3>
            <p className="mt-2 text-sm text-on-surface-variant">当前 Trip：{trips.find((trip) => trip.id === selectedTripId)?.title}</p>
            <div className="mt-5 grid gap-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-outline">地点名称</span>
                <input className="soft-input mt-2 w-full outline-none" value={placeName} onChange={(event) => setPlaceName(event.target.value)} />
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-outline">Latitude</span>
                  <input className="soft-input mt-2 w-full outline-none" type="number" value={lat} onChange={(event) => setLat(Number(event.target.value))} />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-[0.18em] text-outline">Longitude</span>
                  <input className="soft-input mt-2 w-full outline-none" type="number" value={lng} onChange={(event) => setLng(Number(event.target.value))} />
                </label>
              </div>
              <button className="inline-flex w-fit items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white shadow-soft" onClick={() => void addManualPlace(selectedTripId, placeName, lat, lng)} type="button">
                <MapPinned size={17} /> 添加地点
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="safe-panel rounded-[28px] p-6">
            <h3 className="font-serif text-2xl font-semibold text-on-surface">当前地点顺序</h3>
            <div className="mt-4 space-y-3">
              {tripPlaces.map((place, index) => (
                <div key={place.id} className="rounded-2xl bg-white/50 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span>
                      <span className="block text-sm font-semibold">{index + 1}. {place.name}</span>
                      <span className="text-xs text-outline">{place.center.lat.toFixed(3)}, {place.center.lng.toFixed(3)} · {place.photoIds.length} 张</span>
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <button className="grid h-8 w-8 place-items-center rounded-full bg-white/80 text-primary disabled:opacity-35" onClick={() => movePlace(index, -1)} disabled={index === 0} type="button" aria-label="上移地点">
                        <ArrowUp size={14} />
                      </button>
                      <button className="grid h-8 w-8 place-items-center rounded-full bg-white/80 text-primary disabled:opacity-35" onClick={() => movePlace(index, 1)} disabled={index === tripPlaces.length - 1} type="button" aria-label="下移地点">
                        <ArrowDown size={14} />
                      </button>
                      <button className="grid h-8 w-8 place-items-center rounded-full bg-white/80 text-outline" onClick={() => void deleteManualPlace(place.id)} type="button" aria-label="删除地点">
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </div>
                </div>
              ))}
              {tripPlaces.length === 0 ? <p className="text-sm text-on-surface-variant">还没有地点节点。</p> : null}
            </div>
          </div>

          <div className="safe-panel rounded-[28px] p-6">
            <h3 className="font-serif text-2xl font-semibold text-on-surface">绑定未定位照片</h3>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {unboundPhotos.map((photo) => (
                <div key={photo.id} className="rounded-2xl bg-white/55 p-3">
                  <img src={photo.thumbnailUrl} alt={photo.aiCaption} className="h-32 w-full rounded-xl object-cover" />
                  <p className="mt-2 truncate text-sm font-semibold">{photo.title ?? photo.fileName}</p>
                  <select className="mt-3 w-full rounded-full border-0 bg-surface-container-low px-3 py-2 text-sm outline-none" onChange={(event) => void bindPhotoToPlace(photo.id, event.target.value)} defaultValue="">
                    <option value="" disabled>选择地点</option>
                    {tripPlaces.map((place) => (
                      <option key={place.id} value={place.id}>{place.name}</option>
                    ))}
                  </select>
                </div>
              ))}
              {unboundPhotos.length === 0 ? (
                <div className="ai-narrative-block rounded-[24px] p-6 text-sm leading-6 text-on-surface-variant md:col-span-2">
                  当前 Trip 没有未绑定地点的照片。导入缺 GPS 图片或从详情页移出地点后，可在这里手动绑定。
                </div>
              ) : null}
            </div>
            <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary-fixed px-4 py-2 text-xs font-semibold text-primary">
              <Link2 size={14} /> 绑定后会同步更新地球点位、路线和时间轴详情。
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
