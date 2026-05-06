import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { Arc, Marker } from "cobe";
import type { GeoPoint } from "@/domain/models";
import { useAppStore } from "@/store/appStore";

type CobeGlobeOptions = {
  width: number;
  height: number;
  devicePixelRatio: number;
  phi: number;
  theta: number;
  dark: number;
  diffuse: number;
  mapSamples: number;
  mapBrightness: number;
  mapBaseBrightness: number;
  baseColor: [number, number, number];
  markerColor: [number, number, number];
  glowColor: [number, number, number];
  arcColor: [number, number, number];
  arcWidth: number;
  arcHeight: number;
  markerElevation: number;
  scale: number;
  offset: [number, number];
  opacity: number;
  markers: Marker[];
  arcs: Arc[];
  onRender: (state: Partial<CobeGlobeOptions>) => void;
};

const TERRACOTTA: [number, number, number] = [0.58, 0.27, 0.13];
const TERRACOTTA_LIGHT: [number, number, number] = [0.82, 0.45, 0.28];
const SAGE: [number, number, number] = [0.34, 0.39, 0.17];
const PARCHMENT: [number, number, number] = [0.98, 0.93, 0.86];
const GOLD: [number, number, number] = [0.95, 0.75, 0.42];

function markerId(prefix: string, id: string) {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function locationTuple(point: GeoPoint): [number, number] {
  return [point.lat, point.lng];
}

function anchorStyle(anchorId: string): CSSProperties {
  return {
    positionAnchor: `--cobe-${anchorId}`,
    opacity: `var(--cobe-visible-${anchorId}, 0)`,
  } as CSSProperties;
}

function focusAngles(point?: GeoPoint) {
  if (!point) return { phi: 2.18, theta: 0.16 };
  return {
    phi: (-point.lng * Math.PI) / 180 + 1.35,
    theta: Math.max(-0.55, Math.min(0.55, (point.lat * Math.PI) / 360)),
  };
}

export function EarthStage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const globeRef = useRef<{ update: (state: Partial<CobeGlobeOptions>) => void; destroy: () => void } | null>(null);
  const rotationRef = useRef(focusAngles());
  const dataRef = useRef<{ markers: Marker[]; arcs: Arc[] }>({ markers: [], arcs: [] });

  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const selectedPlaceId = useAppStore((state) => state.selectedPlaceId);
  const selectedPhotoId = useAppStore((state) => state.selectedPhotoId);
  const trip = useAppStore((state) => state.trips.find((item) => item.id === selectedTripId));
  const selectedPhoto = useAppStore((state) => state.photos.find((photo) => photo.id === selectedPhotoId));
  const placeNodes = useAppStore((state) => state.placeNodes);
  const photos = useAppStore((state) => state.photos);
  const routes = useAppStore((state) => state.routes);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const selectPhoto = useAppStore((state) => state.selectPhoto);
  const setActivePanel = useAppStore((state) => state.setActivePanel);

  const places = useMemo(() => placeNodes.filter((place) => place.tripId === selectedTripId), [placeNodes, selectedTripId]);
  const tripPhotos = useMemo(() => photos.filter((photo) => photo.tripId === selectedTripId && photo.location), [photos, selectedTripId]);
  const route = useMemo(() => routes.find((item) => item.tripId === selectedTripId), [routes, selectedTripId]);

  const selectedPlace = places.find((place) => place.id === selectedPlaceId);
  const focusPoint = selectedPhoto?.location ?? selectedPlace?.center ?? places[0]?.center;

  const markers = useMemo<Marker[]>(() => {
    const photoMarkers = tripPhotos.map((photo) => ({
      id: markerId("photo", photo.id),
      location: locationTuple(photo.location!),
      size: photo.id === selectedPhotoId ? 0.044 : 0.026,
      color: photo.id === selectedPhotoId ? TERRACOTTA_LIGHT : PARCHMENT,
    }));
    const placeMarkers = places.map((place) => ({
      id: markerId("place", place.id),
      location: locationTuple(place.center),
      size: place.id === selectedPlaceId ? 0.075 : 0.052,
      color: place.id === selectedPlaceId ? TERRACOTTA : GOLD,
    }));
    return [...photoMarkers, ...placeMarkers];
  }, [places, selectedPhotoId, selectedPlaceId, tripPhotos]);

  const arcs = useMemo<Arc[]>(() => {
    if (!route || route.points.length < 2) return [];
    const routeArcs: Arc[] = [];
    for (let index = 0; index < route.points.length - 1; index += 1) {
      routeArcs.push({
        id: markerId("route", `${route.id}-${index}`),
        from: locationTuple(route.points[index]),
        to: locationTuple(route.points[index + 1]),
        color: index === route.points.length - 2 ? TERRACOTTA_LIGHT : SAGE,
      });
    }
    return routeArcs;
  }, [route]);

  useEffect(() => {
    rotationRef.current = focusAngles(focusPoint);
  }, [focusPoint]);

  useEffect(() => {
    dataRef.current = { markers, arcs };
  }, [arcs, markers]);

  useEffect(() => {
    let destroyed = false;
    let currentPhi = rotationRef.current.phi;
    let currentTheta = rotationRef.current.theta;

    async function mountGlobe() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const createGlobe = (await import("cobe")).default;
      if (destroyed || !canvasRef.current) return;

      const globe = createGlobe(canvas, {
        devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
        width: 1200,
        height: 1200,
        phi: currentPhi,
        theta: currentTheta,
        dark: 0,
        diffuse: 1.05,
        mapSamples: 18000,
        mapBrightness: 4.85,
        mapBaseBrightness: 0.08,
        baseColor: [0.9, 0.81, 0.71],
        markerColor: TERRACOTTA_LIGHT,
        glowColor: [1, 0.86, 0.72],
        arcColor: SAGE,
        arcWidth: 0.78,
        arcHeight: 0.28,
        markerElevation: 0.035,
        scale: 1.02,
        offset: [0, 0],
        opacity: 0.96,
        markers: [],
        arcs: [],
        onRender: (state) => {
          const target = rotationRef.current;
          currentPhi += (target.phi - currentPhi) * 0.045 + 0.0012;
          currentTheta += (target.theta - currentTheta) * 0.04;
          state.phi = currentPhi;
          state.theta = currentTheta;
        },
      } as CobeGlobeOptions);
      globeRef.current = globe;
      globe.update(dataRef.current);
    }

    void mountGlobe();
    return () => {
      destroyed = true;
      globeRef.current?.destroy();
      globeRef.current = null;
    };
  }, []);

  useEffect(() => {
    globeRef.current?.update({ markers, arcs });
  }, [arcs, markers]);

  return (
    <section className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none fixed left-1/2 top-1/2 h-[62vmin] w-[62vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-fixed/20 blur-3xl" />
      <div className="cobe-stage fixed inset-0 z-10 grid h-screen w-screen place-items-center">
        <div className="cobe-globe-shell relative h-[min(72vmin,720px)] w-[min(72vmin,720px)]">
          <canvas ref={canvasRef} className="h-full w-full" width={1200} height={1200} aria-label="Earth_Online 抽象粒子地球" />
          {tripPhotos.map((photo) => {
            const anchorId = markerId("photo", photo.id);
            return (
              <button
                key={photo.id}
                className="cobe-photo-hit"
                style={anchorStyle(anchorId)}
                type="button"
                title={photo.title ?? photo.fileName}
                aria-label={`定位照片 ${photo.title ?? photo.fileName}`}
                onClick={() => selectPhoto(photo.id)}
              />
            );
          })}
          {places.map((place) => {
            const anchorId = markerId("place", place.id);
            return (
              <button
                key={place.id}
                className="cobe-place-label"
                style={anchorStyle(anchorId)}
                type="button"
                onClick={() => selectPlace(place.id)}
                aria-label={`定位地点 ${place.name}`}
              >
                <span>{place.name}</span>
                <strong>{place.photoIds.length}</strong>
              </button>
            );
          })}
        </div>
      </div>

      {trip ? (
        <div className="fixed left-5 top-[6.5rem] z-20 max-w-[calc(100vw-2.5rem)] rounded-[24px] bg-white/[0.88] p-5 text-left shadow-ambient backdrop-blur-2xl md:left-28 md:max-w-[360px]">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-outline">当前旅行档案</p>
          <h1 className="mt-2 font-serif text-2xl font-semibold text-primary md:text-3xl">{trip.title}</h1>
          <p className="mt-2 text-sm leading-6 text-on-surface-variant">
            {trip.dateRange.start} - {trip.dateRange.end} · {trip.cities.join(" / ")} · {trip.photoCount} 张照片
          </p>
          {selectedPhoto ? (
            <p className="mt-3 rounded-2xl bg-primary-fixed/65 px-4 py-3 text-xs leading-5 text-primary">
              已定位到 {selectedPhoto.title ?? selectedPhoto.fileName}：{selectedPhoto.aiCaption}
            </p>
          ) : null}
          <button className="mt-4 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-white shadow-soft" onClick={() => setActivePanel("tripDetail")} type="button">
            进入完整旅行档案
          </button>
        </div>
      ) : null}
    </section>
  );
}
