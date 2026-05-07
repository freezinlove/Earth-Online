import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Archive, X } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import ThreeGlobe from "three-globe";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { GeoPoint, Photo, PlaceNode, Trip } from "@/domain/models";
import { useAppStore, type GlobeViewIntent } from "@/store/appStore";

type TravelMarker = {
  id: string;
  kind: "country" | "place";
  label: string;
  center: GeoPoint;
  count: number;
  photoIds: string[];
  tripId: string;
  countryName?: string;
  placeIds?: string[];
  startTime?: string;
  routeRole?: "start" | "end";
  active: boolean;
};

type GlobePath = {
  id: string;
  points: Array<GeoPoint & { alt?: number }>;
  crossCountry: boolean;
  distanceKm: number;
  longHop: boolean;
  active: boolean;
};

type SelectedMapItem =
  | { kind: "country"; id: string }
  | { kind: "place"; id: string }
  | undefined;

type GlobeAssetKind = "landFar" | "landMid" | "landNear" | "coastLine" | "countryLine" | "provinceLine";

const GLOBE_RADIUS = 100;
const GLOBE_SCALE = 0.0185;
const MARKER_ALTITUDE = 0.022;
const ROUTE_LONG_HOP = "#8f3f32";
const ROUTE_ARROW = "#0f6f78";
const LAND_PARTICLE = "#3f9fb3";
const MEDIUM_LAND_PARTICLE = "#49bfd1";
const NEAR_LAND_PARTICLE = "#23abc0";
const COAST_LINE = "#18899d";
const COUNTRY_BOUNDARY_LINE = "#0f788d";
const PROVINCE_BOUNDARY_LINE = "#1598ad";
const GLOBE_SHELL = "#efe1cf";
const LAND_PARTICLE_SIZE = 3.05;
const MEDIUM_LAND_PARTICLE_SIZE = 2.85;
const NEAR_LAND_PARTICLE_SIZE = 2.35;
const AI_PLACEHOLDER = "这里将由 AI 根据地点和照片内容生成一段简短回忆。";
const SCENE_SUFFIXES = ["街景", "山景", "夜景", "风景", "湖景", "河景", "随拍", "路边", "附近"];
const COUNTRY_CENTERS: Record<string, GeoPoint> = {
  中国: { lat: 35.8617, lng: 104.1954 },
  日本: { lat: 36.2048, lng: 138.2529 },
  法国: { lat: 46.2276, lng: 2.2137 },
  瑞士: { lat: 46.8182, lng: 8.2275 },
  意大利: { lat: 41.8719, lng: 12.5674 },
  奥地利: { lat: 47.5162, lng: 14.5501 },
  德国: { lat: 51.1657, lng: 10.4515 },
  匈牙利: { lat: 47.1625, lng: 19.5033 },
  捷克: { lat: 49.8175, lng: 15.473 },
  英国: { lat: 55.3781, lng: -3.436 },
};
const COUNTRY_KEYWORDS: Array<{ country: string; keywords: string[] }> = [
  { country: "日本", keywords: ["日本", "京都", "大阪", "奈良"] },
  { country: "中国", keywords: ["中国", "成都", "康定", "理塘", "川西"] },
  { country: "法国", keywords: ["法国", "巴黎"] },
  { country: "瑞士", keywords: ["瑞士", "卢塞恩", "苏黎世", "SWISS"] },
  { country: "意大利", keywords: ["意大利", "佛罗伦萨", "罗马"] },
  { country: "奥地利", keywords: ["奥地利", "哈尔施塔特", "萨尔茨堡", "维也纳", "萨赫", "因斯布鲁克", "施华洛世奇", "Swarovski"] },
  { country: "德国", keywords: ["德国", "巴伐利亚", "加米施", "帕滕基兴", "艾布湖", "新天鹅堡", "慕尼黑"] },
  { country: "匈牙利", keywords: ["匈牙利", "布达佩斯", "多瑙河"] },
  { country: "捷克", keywords: ["捷克", "布拉格", "查理大桥", "伏尔塔瓦"] },
  { country: "英国", keywords: ["英国", "伦敦"] },
];
const COUNTRY_BOUNDS: Array<{ country: string; minLat: number; maxLat: number; minLng: number; maxLng: number }> = [
  { country: "日本", minLat: 30, maxLat: 46, minLng: 128, maxLng: 146 },
  { country: "中国", minLat: 18, maxLat: 54, minLng: 73, maxLng: 135 },
  { country: "法国", minLat: 41, maxLat: 51.5, minLng: -5.5, maxLng: 9.8 },
  { country: "瑞士", minLat: 45.7, maxLat: 47.9, minLng: 5.7, maxLng: 10.7 },
  { country: "意大利", minLat: 36, maxLat: 47.2, minLng: 6.5, maxLng: 18.8 },
  { country: "奥地利", minLat: 46.3, maxLat: 49.1, minLng: 9.4, maxLng: 17.2 },
  { country: "德国", minLat: 47.2, maxLat: 55.2, minLng: 5.8, maxLng: 15.2 },
  { country: "匈牙利", minLat: 45.6, maxLat: 48.7, minLng: 16, maxLng: 22.9 },
  { country: "捷克", minLat: 48.5, maxLat: 51.1, minLng: 12, maxLng: 18.9 },
  { country: "英国", minLat: 49.8, maxLat: 60.9, minLng: -8.8, maxLng: 2.1 },
];
const LOCAL_COUNTRY_HINTS: Array<{ country: string; center: GeoPoint; radiusKm: number }> = [
  { country: "奥地利", center: { lat: 47.2692, lng: 11.4041 }, radiusKm: 34 },
  { country: "奥地利", center: { lat: 47.8095, lng: 13.055 }, radiusKm: 28 },
  { country: "奥地利", center: { lat: 47.5622, lng: 13.6493 }, radiusKm: 24 },
  { country: "德国", center: { lat: 47.4917, lng: 11.0955 }, radiusKm: 32 },
  { country: "瑞士", center: { lat: 47.3769, lng: 8.5417 }, radiusKm: 32 },
  { country: "匈牙利", center: { lat: 47.4979, lng: 19.0402 }, radiusKm: 36 },
];
const PLACE_NAME_HINTS: Array<{ name: string; keywords: string[] }> = [
  { name: "因斯布鲁克", keywords: ["因斯布鲁克", "施华洛世奇", "Swarovski", "AC Hotel", "万豪"] },
  { name: "哈尔施塔特", keywords: ["哈尔施塔特", "Hallstatt"] },
  { name: "萨尔茨堡", keywords: ["萨尔茨堡", "Salzburg", "萨赫"] },
  { name: "加米施-帕滕基兴", keywords: ["加米施", "帕滕基兴", "Garmisch"] },
  { name: "艾布湖", keywords: ["艾布湖", "Eibsee", "新天鹅堡"] },
  { name: "布达佩斯", keywords: ["布达佩斯", "Budapest", "链子桥"] },
  { name: "苏黎世", keywords: ["苏黎世", "Zurich", "SWISS"] },
  { name: "布拉格", keywords: ["布拉格", "Prague", "Praha", "查理大桥"] },
];
const GLOBE_ASSET_PATHS: Record<GlobeAssetKind, string> = {
  landFar: "/data/globe/land-far.bin",
  landMid: "/data/globe/land-mid.bin",
  landNear: "/data/globe/land-near.bin",
  coastLine: "/data/globe/coast-lines.bin",
  countryLine: "/data/globe/country-lines.bin",
  provinceLine: "/data/globe/province-lines.bin",
};

function createPointTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return undefined;

  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 30);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.42, "rgba(255,255,255,0.86)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const progress = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function zoomProgress(camera: THREE.Camera) {
  return THREE.MathUtils.clamp((6.8 - camera.position.length()) / (6.8 - 2.05), 0, 1);
}

function orbitRotateSpeed(camera: THREE.Camera) {
  const zoom = smoothstep(0.08, 0.92, zoomProgress(camera));
  return THREE.MathUtils.lerp(0.58, 0.075, zoom);
}

function formatDate(date?: string) {
  if (!date) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));
}

function normalizePlaceName(name: string) {
  return (
    SCENE_SUFFIXES.reduce((value, suffix) => value.replace(new RegExp(`${suffix}$`), ""), name)
      .replace(/地点\s*\d+$/u, "")
      .trim() || name
  );
}

function distanceKm(start: GeoPoint, end: GeoPoint) {
  const lat1 = THREE.MathUtils.degToRad(start.lat);
  const lat2 = THREE.MathUtils.degToRad(end.lat);
  const dLat = lat2 - lat1;
  const dLng = THREE.MathUtils.degToRad(end.lng - start.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function centerOf(points: GeoPoint[]) {
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

function hoursBetween(first?: string, second?: string) {
  if (!first || !second) return Number.POSITIVE_INFINITY;
  const firstTime = new Date(first).getTime();
  const secondTime = new Date(second).getTime();
  if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime)) return Number.POSITIVE_INFINITY;
  return Math.abs(firstTime - secondTime) / 36e5;
}

function hideBackHemisphere(material: THREE.Material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vGlobeFacing;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vec3 globeCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
vec3 globeWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
vec3 globeNormal = normalize(globeWorldPosition - globeCenter);
vec3 globeView = normalize(cameraPosition - globeCenter);
vGlobeFacing = dot(globeNormal, globeView);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlobeFacing;")
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
if (vGlobeFacing < 0.035) discard;`,
      );
  };
}

function createParticleGeometry(positions?: Float32Array) {
  const geometry = new THREE.BufferGeometry();
  if (positions) {
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
  }
  return geometry;
}

function useGlobeAssetGeometry(kind: GlobeAssetKind) {
  const [positions, setPositions] = useState<Float32Array>();

  useEffect(() => {
    const controller = new AbortController();

    fetch(GLOBE_ASSET_PATHS[kind], { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load globe asset: ${GLOBE_ASSET_PATHS[kind]}`);
        return response.arrayBuffer();
      })
      .then((buffer) => setPositions(new Float32Array(buffer)))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.error(error);
      });

    return () => controller.abort();
  }, [kind]);

  return useMemo(() => createParticleGeometry(positions), [positions]);
}

function buildRouteStops(places: TravelMarker[]) {
  const orderedPlaces = places
    .filter((place) => place.kind === "place")
    .slice()
    .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));

  return orderedPlaces.reduce<TravelMarker[]>((stops, place) => {
    const previous = stops[stops.length - 1];
    if (!previous) return [place];
    const sameCountry = previous.countryName === place.countryName;
    const localStay = sameCountry && distanceKm(previous.center, place.center) < 35;
    if (!localStay) return [...stops, place];

    const previousWeight = Math.max(previous.count, 1);
    const nextWeight = Math.max(place.count, 1);
    const mergedWeight = previousWeight + nextWeight;
    stops[stops.length - 1] = {
      ...previous,
      id: `${previous.id}-${place.id}`,
      label: previous.label,
      center: {
        lat: (previous.center.lat * previousWeight + place.center.lat * nextWeight) / mergedWeight,
        lng: (previous.center.lng * previousWeight + place.center.lng * nextWeight) / mergedWeight,
      },
      count: previous.count + place.count,
      photoIds: Array.from(new Set([...previous.photoIds, ...place.photoIds])),
      placeIds: Array.from(new Set([...(previous.placeIds ?? []), ...(place.placeIds ?? [])])),
      active: previous.active || place.active,
    };
    return stops;
  }, []);
}

function applyRouteRoles(markers: TravelMarker[]) {
  const routeStops = buildRouteStops(markers);
  const firstStop = routeStops[0];
  const lastStop = routeStops[routeStops.length - 1];
  if (!firstStop || !lastStop) return markers;

  const firstPlaceIds = new Set(firstStop.placeIds ?? []);
  const lastPlaceIds = new Set(lastStop.placeIds ?? []);
  return markers.map((marker) => {
    const placeIds = marker.placeIds ?? [];
    const routeRole: TravelMarker["routeRole"] = placeIds.some((id) => firstPlaceIds.has(id)) ? "start" : placeIds.some((id) => lastPlaceIds.has(id)) ? "end" : undefined;
    return { ...marker, routeRole };
  });
}

function routePaths(places: TravelMarker[], selected?: TravelMarker): GlobePath[] {
  const orderedPlaces = buildRouteStops(places);
  if (orderedPlaces.length < 2) return [];

  return orderedPlaces.slice(0, -1).map((place, index) => {
    const nextPlace = orderedPlaces[index + 1];
    const point = place.center;
    const next = nextPlace.center;
    const segmentKm = distanceKm(point, next);
    const distance = segmentKm / 6371;
    const crossCountry = place.countryName !== nextPlace.countryName;
    const longHop = segmentKm >= 120;
    const midAlt = longHop ? Math.min(0.13, 0.024 + distance * 0.08) : 0.024;
    const active =
      !!selected &&
      selected.kind === "place" &&
      [point, next].some((routePoint) => distanceKm(routePoint, selected.center) < 18);
    return {
      id: `${place.id}-${nextPlace.id}`,
      active,
      crossCountry,
      distanceKm: segmentKm,
      longHop,
      points: !longHop
        ? [
            { ...point, alt: 0.024 },
            { ...next, alt: 0.024 },
          ]
        : [
            { ...point, alt: 0.024 },
            { lat: (point.lat + next.lat) / 2, lng: (point.lng + next.lng) / 2, alt: midAlt },
            { ...next, alt: 0.024 },
          ],
    };
  });
}

function threeGlobeVector(point: GeoPoint, radius = GLOBE_RADIUS, altitude = 0) {
  const phi = THREE.MathUtils.degToRad(90 - point.lat);
  const theta = THREE.MathUtils.degToRad(90 - point.lng);
  const scaledRadius = radius * (1 + altitude);
  return new THREE.Vector3(
    scaledRadius * Math.sin(phi) * Math.cos(theta),
    scaledRadius * Math.cos(phi),
    scaledRadius * Math.sin(phi) * Math.sin(theta),
  );
}

function focusQuaternion(point?: GeoPoint) {
  const longitude = point?.lng ?? 33.2;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(-longitude), 0));
}

function cameraTargetForIntent(intent: GlobeViewIntent, fallbackPoint?: GeoPoint) {
  const point = "point" in intent ? intent.point : fallbackPoint;
  const distance = intent.source === "timeline-place" ? 2.18 : intent.source === "timeline-trip-entry" ? 3.85 : intent.source === "timeline-trip" ? 5.85 : 5.25;
  const latitude = point?.lat ?? 18;
  const latitudeStrength = intent.source === "timeline-place" ? 1 : intent.source === "timeline-trip-entry" ? 0.82 : 0.58;
  const y = THREE.MathUtils.clamp(Math.sin(THREE.MathUtils.degToRad(latitude)) * distance * latitudeStrength, -distance * 0.78, distance * 0.78);
  const z = Math.sqrt(Math.max(distance * distance - y * y, 0.4));
  return new THREE.Vector3(0, y, z);
}

function getCountryForPoint(point: GeoPoint, trip: Trip) {
  if (trip.countries.length <= 1) return trip.countries[0] ?? "未知国家";

  return trip.countries.reduce((closest, country) => {
    const center = COUNTRY_CENTERS[country];
    if (!center) return closest;
    const score = distanceKm(point, center);
    return score < closest.score ? { name: country, score } : closest;
  }, { name: trip.countries[0], score: Number.POSITIVE_INFINITY }).name;
}

function inferCountryFromText(text: string) {
  const lowerText = text.toLowerCase();
  return COUNTRY_KEYWORDS.find((entry) => entry.keywords.some((keyword) => lowerText.includes(keyword.toLowerCase())))?.country;
}

function inferCountryFromBounds(point: GeoPoint) {
  return COUNTRY_BOUNDS.find(
    (bounds) => point.lat >= bounds.minLat && point.lat <= bounds.maxLat && point.lng >= bounds.minLng && point.lng <= bounds.maxLng,
  )?.country;
}

function inferCountryForGroup(group: { name: string; places: PlaceNode[]; photos: Photo[]; centers: GeoPoint[] }, trip?: Trip) {
  const center = centerOf(group.centers);
  const localHint = LOCAL_COUNTRY_HINTS.find((hint) => distanceKm(center, hint.center) <= hint.radiusKm);
  if (localHint) return localHint.country;

  const metadata = [
    group.name,
    ...group.places.map((place) => place.name),
    ...group.photos.flatMap((photo) => [photo.title, photo.fileName, photo.aiCaption, ...(photo.tags ?? [])]),
  ]
    .filter(Boolean)
    .join(" ");
  const textCountry = inferCountryFromText(metadata);
  if (textCountry) return textCountry;

  const boundCountry = inferCountryFromBounds(center);
  if (boundCountry) return boundCountry;

  return trip ? getCountryForPoint(center, trip) : "未知国家";
}

function groupMetadata(group: { name: string; places: PlaceNode[]; photos: Photo[] }) {
  return [
    group.name,
    ...group.places.map((place) => place.name),
    ...group.photos.flatMap((photo) => [photo.title, photo.fileName, photo.aiCaption, ...(photo.tags ?? [])]),
  ]
    .filter(Boolean)
    .join(" ");
}

function inferPlaceNameForGroup(group: { name: string; places: PlaceNode[]; photos: Photo[] }) {
  const metadata = groupMetadata(group).toLowerCase();
  return PLACE_NAME_HINTS.find((hint) => hint.keywords.some((keyword) => metadata.includes(keyword.toLowerCase())))?.name ?? group.name;
}

function buildPlaceMarkers(places: PlaceNode[], photos: Photo[], trip?: Trip) {
  const groups: Array<{ name: string; places: PlaceNode[]; photos: Photo[]; centers: GeoPoint[] }> = [];

  places.forEach((place) => {
    const placePhotos = photos.filter((photo) => photo.placeNodeId === place.id || place.photoIds.includes(photo.id));
    const photoCenters = placePhotos.map((photo) => photo.location).filter(Boolean) as GeoPoint[];
    const centers = photoCenters.length ? photoCenters : [place.center];
    const center = centerOf(centers);
    const key = normalizePlaceName(place.name);
    const entry = groups.find((group) => group.name === key && distanceKm(centerOf(group.centers), center) <= 8) ?? {
      name: key,
      places: [],
      photos: [],
      centers: [],
    };
    entry.places.push(place);
    entry.photos.push(...placePhotos);
    entry.centers.push(...centers);
    if (!groups.includes(entry)) groups.push(entry);
  });

  const markers = groups.map((group) => {
    const photoIds = Array.from(new Set(group.photos.map((photo) => photo.id)));
    const placeIds = group.places.map((place) => place.id);
    const startTime = group.places
      .map((place) => place.timeRange.start)
      .sort((a, b) => a.localeCompare(b))[0];
    return {
      id: `place-${placeIds.join("-")}`,
      kind: "place" as const,
      label: inferPlaceNameForGroup(group),
      center: centerOf(group.centers),
      count: photoIds.length,
      photoIds,
      placeIds,
      tripId: group.places[0]?.tripId ?? "",
      countryName: inferCountryForGroup(group, trip),
      startTime,
      active: false,
    };
  });

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const nearby = markers.find((candidate, candidateIndex) => {
      if (candidateIndex <= index || candidate.countryName !== marker.countryName) return false;
      const distance = distanceKm(marker.center, candidate.center);
      const closePoi = distance < 5;
      const cityStay = distance < 25 && hoursBetween(marker.startTime, candidate.startTime) <= 36;
      return closePoi || cityStay;
    });
    if (!nearby) continue;
    marker.photoIds = Array.from(new Set([...marker.photoIds, ...nearby.photoIds]));
    marker.placeIds = Array.from(new Set([...(marker.placeIds ?? []), ...(nearby.placeIds ?? [])]));
    marker.count = marker.photoIds.length;
    marker.center = centerOf([marker.center, nearby.center]);
    marker.startTime = [marker.startTime, nearby.startTime].filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)))[0];
    markers.splice(markers.indexOf(nearby), 1);
  }

  return markers;
}

function buildCountryMarkers(trip: Trip | undefined, placeMarkers: TravelMarker[]) {
  if (!trip) return [];

  const groups = new Map<string, TravelMarker[]>();
  placeMarkers.forEach((place) => {
    const country = place.countryName ?? getCountryForPoint(place.center, trip);
    groups.set(country, [...(groups.get(country) ?? []), place]);
  });

  return Array.from(groups.entries()).map(([country, places]) => {
    const photoIds = Array.from(new Set(places.flatMap((place) => place.photoIds)));
    const routeRole: TravelMarker["routeRole"] = places.some((place) => place.routeRole === "start")
      ? "start"
      : places.some((place) => place.routeRole === "end")
        ? "end"
        : undefined;
    return {
      id: `country-${country}`,
      kind: "country" as const,
      label: country,
      center: centerOf(places.map((place) => place.center)),
      count: places.length,
      photoIds,
      placeIds: places.flatMap((place) => place.placeIds ?? []),
      tripId: trip.id,
      countryName: country,
      startTime: places
        .map((place) => place.startTime)
        .filter(Boolean)
        .sort((a, b) => String(a).localeCompare(String(b)))[0],
      routeRole,
      active: false,
    };
  });
}

function LandParticleLayer() {
  const geometry = useGlobeAssetGeometry("landFar");
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const pointTexture = useMemo(() => createPointTexture(), []);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    if (!materialRef.current) return;
    hideBackHemisphere(materialRef.current);
    materialRef.current.needsUpdate = true;
  }, []);

  useFrame(({ clock }) => {
    if (!materialRef.current) return;
    const zoom = zoomProgress(camera);
    const fadeOut = smoothstep(0.22, 0.5, zoom);
    materialRef.current.opacity = (0.62 + Math.sin(clock.elapsedTime * 0.7) * 0.018) * THREE.MathUtils.lerp(1, 0.035, fadeOut);
  });

  return (
    <points geometry={geometry} renderOrder={2}>
      <pointsMaterial
        ref={materialRef}
        map={pointTexture}
        alphaTest={0.08}
        size={LAND_PARTICLE_SIZE}
        sizeAttenuation={false}
        color={LAND_PARTICLE}
        transparent
        opacity={0.86}
        depthTest={false}
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </points>
  );
}

function MediumLandParticleLayer() {
  const geometry = useGlobeAssetGeometry("landMid");
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const pointTexture = useMemo(() => createPointTexture(), []);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    if (!materialRef.current) return;
    hideBackHemisphere(materialRef.current);
    materialRef.current.needsUpdate = true;
  }, []);

  useFrame(({ clock }) => {
    if (!materialRef.current) return;
    const zoom = zoomProgress(camera);
    const fadeIn = smoothstep(0.34, 0.58, zoom);
    const fadeOut = smoothstep(0.68, 0.88, zoom);
    materialRef.current.opacity = fadeIn * THREE.MathUtils.lerp(1, 0.08, fadeOut) * (0.7 + Math.sin(clock.elapsedTime * 0.62) * 0.01);
  });

  return (
    <points geometry={geometry} renderOrder={3}>
      <pointsMaterial
        ref={materialRef}
        map={pointTexture}
        alphaTest={0.08}
        size={MEDIUM_LAND_PARTICLE_SIZE}
        sizeAttenuation={false}
        color={MEDIUM_LAND_PARTICLE}
        transparent
        opacity={0}
        depthTest={false}
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </points>
  );
}

function NearLandParticleLayer() {
  const geometry = useGlobeAssetGeometry("landNear");
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const pointTexture = useMemo(() => createPointTexture(), []);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    if (!materialRef.current) return;
    hideBackHemisphere(materialRef.current);
    materialRef.current.needsUpdate = true;
  }, []);

  useFrame(({ clock }) => {
    if (!materialRef.current) return;
    const zoom = zoomProgress(camera);
    const opacity = smoothstep(0.72, 0.94, zoom);
    materialRef.current.opacity = opacity * (0.9 + Math.sin(clock.elapsedTime * 0.58) * 0.012);
  });

  return (
    <points geometry={geometry} renderOrder={4}>
      <pointsMaterial
        ref={materialRef}
        map={pointTexture}
        alphaTest={0.08}
        size={NEAR_LAND_PARTICLE_SIZE}
        sizeAttenuation={false}
        color={NEAR_LAND_PARTICLE}
        transparent
        opacity={0}
        depthTest={false}
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </points>
  );
}

function AssetLineLayer({ kind, color, baseOpacity, renderOrder }: { kind: GlobeAssetKind; color: string; baseOpacity: number; renderOrder: number }) {
  const geometry = useGlobeAssetGeometry(kind);
  const materialRef = useRef<THREE.LineBasicMaterial>(null);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    if (!materialRef.current) return;
    hideBackHemisphere(materialRef.current);
    materialRef.current.needsUpdate = true;
  }, []);

  useFrame(() => {
    if (!materialRef.current || kind === "coastLine") return;
    const zoom = zoomProgress(camera);
    materialRef.current.opacity =
      kind === "countryLine"
        ? smoothstep(0.4, 0.7, zoom) * (1 - smoothstep(0.76, 0.94, zoom) * 0.32) * baseOpacity
        : smoothstep(0.72, 0.92, zoom) * baseOpacity;
  });

  return (
    <lineSegments geometry={geometry} renderOrder={renderOrder}>
      <lineBasicMaterial
        ref={materialRef}
        color={color}
        transparent
        opacity={kind === "coastLine" ? baseOpacity : 0}
        depthTest={false}
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </lineSegments>
  );
}

function TravelRouteLayer({ paths }: { paths: GlobePath[] }) {
  const camera = useThree((state) => state.camera);
  const [zoom, setZoom] = useState(0);
  const lines = useMemo(
    () =>
      paths.map((path) => {
        const controlPoints = path.points.map((point) => threeGlobeVector(point, GLOBE_RADIUS, point.alt ?? 0.006));
        const curve = new THREE.CatmullRomCurve3(controlPoints);
        const arrowPoint = curve.getPoint(0.58);
        const arrowDirectionPoint = curve.getPoint(0.64);
        return {
          id: path.id,
          active: path.active,
          crossCountry: path.crossCountry,
          distanceKm: path.distanceKm,
          longHop: path.longHop,
          points: curve.getPoints(42).map((point) => point.toArray() as [number, number, number]),
          arrowPosition: arrowPoint.toArray() as [number, number, number],
          arrowDirectionPoint: arrowDirectionPoint.toArray() as [number, number, number],
        };
      }),
    [paths],
  );

  useFrame(() => {
    const nextZoom = zoomProgress(camera);
    setZoom((current) => (Math.abs(current - nextZoom) > 0.015 ? nextZoom : current));
  });

  return (
    <>
      {lines.map((line) => {
        const intraCountryOpacity = smoothstep(0.34, 0.6, zoom) * 0.88;
        const crossCountryOpacity = THREE.MathUtils.lerp(0.92, 0.62, smoothstep(0.45, 0.82, zoom));
        const opacity = line.crossCountry ? crossCountryOpacity : intraCountryOpacity;
        const arrowOpacity = smoothstep(0.68, 0.84, zoom);
        if (opacity < 0.025) return null;
        const color = ROUTE_LONG_HOP;
        return (
          <group key={line.id}>
            <Line
              points={line.points}
              color={color}
              lineWidth={line.active ? 3.5 : line.longHop ? 3.05 : 2.45}
              transparent
              opacity={line.active ? Math.max(opacity, 0.72) : opacity}
              depthWrite={false}
              depthTest={false}
              renderOrder={12}
            />
            {arrowOpacity > 0.02 ? (
              <RouteArrow color={ROUTE_ARROW} directionPoint={line.arrowDirectionPoint} opacity={arrowOpacity} position={line.arrowPosition} />
            ) : null}
          </group>
        );
      })}
    </>
  );
}

function RouteArrow({
  color,
  directionPoint,
  opacity,
  position,
}: {
  color: string;
  directionPoint: [number, number, number];
  opacity: number;
  position: [number, number, number];
}) {
  const camera = useThree((state) => state.camera);
  const anchorRef = useRef<THREE.Group>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  const localStart = useMemo(() => new THREE.Vector3(...position), [position]);
  const localEnd = useMemo(() => new THREE.Vector3(...directionPoint), [directionPoint]);

  useFrame(() => {
    const parent = anchorRef.current?.parent;
    if (!parent || !arrowRef.current) return;

    const screenStart = localStart.clone().applyMatrix4(parent.matrixWorld).project(camera);
    const screenEnd = localEnd.clone().applyMatrix4(parent.matrixWorld).project(camera);
    const dx = screenEnd.x - screenStart.x;
    const dy = screenStart.y - screenEnd.y;
    if (Math.hypot(dx, dy) < 0.0001) return;
    arrowRef.current.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  });

  return (
    <group ref={anchorRef}>
      <Html center position={position} zIndexRange={[32, 14]} transform={false}>
        <span ref={arrowRef} className="travel-route-arrow" style={{ color, opacity }} />
      </Html>
    </group>
  );
}

function ThreeGlobeLayer() {
  const globe = useMemo(
    () =>
      new ThreeGlobe({
        waitForGlobeReady: true,
        animateIn: false,
      }),
    [],
  );

  useEffect(() => {
    globe.renderOrder = 1;

    const material = new THREE.MeshStandardMaterial({
      color: GLOBE_SHELL,
      roughness: 0.76,
      metalness: 0.03,
      emissive: "#e3d2bc",
      emissiveIntensity: 0.24,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });

    globe.globeMaterial(material).showAtmosphere(true).atmosphereColor("#f7dcc0").atmosphereAltitude(0.1);
  }, [globe]);

  return <primitive object={globe} />;
}

function BillboardMarker({
  marker,
  onSelect,
}: {
  marker: TravelMarker;
  onSelect: (marker: TravelMarker) => void;
}) {
  const camera = useThree((state) => state.camera);
  const [opacity, setOpacity] = useState(0);
  const position = useMemo(() => threeGlobeVector(marker.center, GLOBE_RADIUS, MARKER_ALTITUDE).toArray(), [marker.center]);

  useFrame(() => {
    const zoom = zoomProgress(camera);
    const lodOpacity =
      marker.kind === "country"
        ? 1 - smoothstep(0.28, 0.56, zoom)
        : smoothstep(0.28, 0.56, zoom);
    setOpacity(lodOpacity);
  });

  if (opacity < 0.02) return null;

  return (
    <Html center position={position} zIndexRange={[40, 20]} transform={false}>
      <button
        className={`travel-marker travel-marker--${marker.kind}${marker.active ? " is-selected" : ""}${marker.routeRole ? ` is-${marker.routeRole}` : ""}`}
        style={{ opacity }}
        aria-label={marker.label}
        title={marker.label}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onSelect(marker);
        }}
      >
        {marker.kind === "country" ? null : <span className="travel-marker-dot" />}
      </button>
    </Html>
  );
}

function GlobeScene({
  markers,
  paths,
  focusPoint,
  viewIntent,
  onManualView,
  onSelect,
}: {
  markers: TravelMarker[];
  paths: GlobePath[];
  focusPoint?: GeoPoint;
  viewIntent: GlobeViewIntent;
  onManualView: () => void;
  onSelect: (marker: TravelMarker) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const camera = useThree((state) => state.camera);
  const targetQuaternion = useRef(focusQuaternion(focusPoint));
  const targetCameraPosition = useRef(camera.position.clone());
  const globeCenter = useMemo(() => new THREE.Vector3(0, 0, 0), []);

  useEffect(() => {
    targetQuaternion.current = focusQuaternion(focusPoint);
  }, [focusPoint]);

  useEffect(() => {
    if ("clearViewOffset" in camera) {
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
    }
  }, [camera]);

  useEffect(() => {
    if (viewIntent.source === "manual") return;
    targetCameraPosition.current = cameraTargetForIntent(viewIntent, focusPoint);
  }, [camera, focusPoint, viewIntent]);

  useFrame(() => {
    if (controlsRef.current) {
      controlsRef.current.rotateSpeed = THREE.MathUtils.lerp(controlsRef.current.rotateSpeed, orbitRotateSpeed(camera), 0.12);
    }

    if (viewIntent.source !== "manual") {
      if (groupRef.current) groupRef.current.quaternion.slerp(targetQuaternion.current, 0.045);
      camera.position.lerp(targetCameraPosition.current, 0.055);
      camera.up.set(0, 1, 0);
      controlsRef.current?.target.lerp(globeCenter, 0.16);
      camera.lookAt(globeCenter);
      controlsRef.current?.update();
    }
  });

  const handleManualStart = () => {
    onManualView();
  };

  return (
    <>
      <ambientLight intensity={1.95} />
      <directionalLight position={[3, 4, 5]} intensity={1.35} color="#d9f6ff" />
      <pointLight position={[-4, -2, 3]} color="#ff7aa8" intensity={1.55} />
      <group ref={groupRef} scale={GLOBE_SCALE}>
        <ThreeGlobeLayer />
        <LandParticleLayer />
        <MediumLandParticleLayer />
        <NearLandParticleLayer />
        <AssetLineLayer kind="coastLine" color={COAST_LINE} baseOpacity={0.5} renderOrder={5} />
        <AssetLineLayer kind="countryLine" color={COUNTRY_BOUNDARY_LINE} baseOpacity={0.36} renderOrder={6} />
        <AssetLineLayer kind="provinceLine" color={PROVINCE_BOUNDARY_LINE} baseOpacity={0.44} renderOrder={7} />
        <TravelRouteLayer paths={paths} />
        {markers.map((marker) => (
          <BillboardMarker key={marker.id} marker={marker} onSelect={onSelect} />
        ))}
      </group>
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.08}
        enablePan={false}
        rotateSpeed={0.58}
        zoomSpeed={0.8}
        minDistance={2.05}
        maxDistance={6.8}
        target={[0, 0, 0]}
        onStart={handleManualStart}
      />
    </>
  );
}

function TravelInfoPanel({
  selected,
  trip,
  photos,
  onOpenArchive,
  onOpenPhoto,
  onClose,
}: {
  selected?: TravelMarker;
  trip?: Trip;
  photos: Photo[];
  onOpenArchive: () => void;
  onOpenPhoto: (photo: Photo) => void;
  onClose: () => void;
}) {
  if (!selected || !trip) return null;

  const relatedPhotos = photos.filter((photo) => selected.photoIds.includes(photo.id));

  return (
    <aside className="travel-info-panel">
      <button className="travel-panel-close" type="button" aria-label="关闭信息面板" onClick={onClose}>
        <X size={16} />
      </button>
      <p className="travel-panel-kicker">{selected.kind === "country" ? trip.title : "地点回忆"}</p>
      <h2>{selected.kind === "country" ? selected.countryName : selected.label}</h2>
      {selected.kind === "place" ? <p className="travel-panel-copy">{AI_PLACEHOLDER}</p> : <p className="travel-panel-copy">{trip.title}</p>}
      {selected.kind === "place" && relatedPhotos.length > 0 ? (
        <div className="travel-photo-strip" aria-label="相关照片">
          {relatedPhotos.map((photo) => (
            <button key={photo.id} type="button" className="travel-photo-thumb" onClick={() => onOpenPhoto(photo)} aria-label={photo.title ?? photo.fileName}>
              <img src={photo.thumbnailUrl} alt={photo.title ?? photo.fileName} />
            </button>
          ))}
        </div>
      ) : null}
      <button className="travel-archive-button" type="button" onClick={onOpenArchive}>
        <Archive size={16} />
        进入档案
      </button>
    </aside>
  );
}

function PhotoLightbox({ photo, placeName, onClose }: { photo?: Photo; placeName?: string; onClose: () => void }) {
  if (!photo) return null;

  return (
    <div className="travel-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="travel-lightbox-card" onClick={(event) => event.stopPropagation()}>
        <button className="travel-lightbox-close" type="button" aria-label="关闭照片预览" onClick={onClose}>
          <X size={18} />
        </button>
        <img src={photo.storageUrl ?? photo.thumbnailUrl} alt={photo.title ?? photo.fileName} />
        <div>
          <p>{formatDate(photo.capturedAt)}</p>
          <h3>{photo.title ?? photo.fileName}</h3>
          <span>{placeName ?? "地点未归档"}</span>
        </div>
      </div>
    </div>
  );
}

export function EarthStage() {
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const selectedPlaceId = useAppStore((state) => state.selectedPlaceId);
  const trips = useAppStore((state) => state.trips);
  const placeNodes = useAppStore((state) => state.placeNodes);
  const photos = useAppStore((state) => state.photos);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const globeViewIntent = useAppStore((state) => state.globeViewIntent);
  const setGlobeViewIntent = useAppStore((state) => state.setGlobeViewIntent);
  const [selectedMapItem, setSelectedMapItem] = useState<SelectedMapItem>();
  const [previewPhoto, setPreviewPhoto] = useState<Photo>();

  const trip = trips.find((item) => item.id === selectedTripId);
  const places = useMemo(() => placeNodes.filter((place) => place.tripId === selectedTripId), [placeNodes, selectedTripId]);
  const tripPhotos = useMemo(() => photos.filter((photo) => photo.tripId === selectedTripId && photo.location), [photos, selectedTripId]);
  const placeMarkers = useMemo(() => applyRouteRoles(buildPlaceMarkers(places, tripPhotos, trip)), [places, trip, tripPhotos]);
  const countryMarkers = useMemo(() => buildCountryMarkers(trip, placeMarkers), [placeMarkers, trip]);
  const selectedMarker = [...countryMarkers, ...placeMarkers].find((marker) => marker.id === selectedMapItem?.id);
  const markers = useMemo(
    () => [...countryMarkers, ...placeMarkers].map((marker) => ({ ...marker, active: marker.id === selectedMapItem?.id || marker.active })),
    [countryMarkers, placeMarkers, selectedMapItem?.id],
  );
  const activeMarker = markers.find((marker) => marker.id === selectedMapItem?.id) ?? markers.find((marker) => marker.active);
  const tripFocusPoint = useMemo(() => (placeMarkers.length ? centerOf(placeMarkers.map((place) => place.center)) : undefined), [placeMarkers]);
  const focusPoint = "point" in globeViewIntent ? globeViewIntent.point : activeMarker?.center ?? tripFocusPoint ?? placeMarkers[0]?.center;
  const paths = useMemo(() => routePaths(placeMarkers, activeMarker), [activeMarker, placeMarkers]);
  const previewPlace = previewPhoto?.placeNodeId ? places.find((place) => place.id === previewPhoto.placeNodeId) : undefined;

  useEffect(() => {
    if (!selectedPlaceId) return;
    const marker = placeMarkers.find((item) => item.placeIds?.includes(selectedPlaceId));
    if (marker) setSelectedMapItem({ kind: "place", id: marker.id });
  }, [placeMarkers, selectedPlaceId]);

  useEffect(() => {
    if (!selectedPlaceId && selectedMapItem?.kind === "place") setSelectedMapItem(undefined);
  }, [selectedMapItem?.kind, selectedPlaceId]);

  const handleSelect = (marker: TravelMarker) => {
    if (selectedMapItem?.id === marker.id) {
      setSelectedMapItem(undefined);
      return;
    }
    setSelectedMapItem({ kind: marker.kind, id: marker.id });
    if (marker.kind === "place" && marker.placeIds?.[0]) selectPlace(marker.placeIds[0]);
  };

  return (
    <section className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none fixed left-1/2 top-1/2 h-[76vmin] w-[76vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-fixed/20 blur-3xl" />
      <div className="three-globe-stage fixed inset-0 z-10 h-screen w-screen">
        <Canvas camera={{ position: [0, 0, 5.25], fov: 42, near: 0.1, far: 1000 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
          <Suspense fallback={null}>
            <GlobeScene
              markers={markers}
              paths={paths}
              focusPoint={focusPoint}
              viewIntent={globeViewIntent}
              onManualView={() => setGlobeViewIntent({ source: "manual" })}
              onSelect={handleSelect}
            />
          </Suspense>
        </Canvas>
      </div>
      <TravelInfoPanel
        selected={selectedMarker}
        trip={trip}
        photos={tripPhotos}
        onOpenArchive={() => setActivePanel("tripDetail")}
        onOpenPhoto={setPreviewPhoto}
        onClose={() => setSelectedMapItem(undefined)}
      />
      <PhotoLightbox photo={previewPhoto} placeName={previewPlace?.name} onClose={() => setPreviewPhoto(undefined)} />
    </section>
  );
}
