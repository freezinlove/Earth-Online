import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Archive, MapPin, X } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import ThreeGlobe from "three-globe";
import type { Line2, LineSegments2, OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { capturedDateTimeLabel } from "@/domain/datetime";
import { countryLabel, markerLabel, photoAltText, photoLabel, placeLabel } from "@/domain/labels";
import { useI18n } from "@/i18n/useI18n";
import type { GeoPoint, GlobeMarker, Photo, Trip } from "@/domain/models";
import { useAppStore, type GlobeViewIntent, type Locale } from "@/store/appStore";

export type TravelMarker = {
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
  endTime?: string;
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
const GLOBE_SHELL = "#e8ded2";
const GLOBE_RIM = "#79cad6";
const LAND_PARTICLE_SIZE = 3.05;
const MEDIUM_LAND_PARTICLE_SIZE = 2.85;
const NEAR_LAND_PARTICLE_SIZE = 2.35;
const MARKER_INTERACTIVE_OPACITY = 0.025;
const PLACE_MARKER_INTERACTIVE_COUNTRY_OPACITY = 0.08;
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
  return THREE.MathUtils.lerp(0.58, 0.026, zoom);
}

function formatDate(date?: string) {
  return capturedDateTimeLabel(date);
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

export function applyRouteRoles(markers: TravelMarker[]) {
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

function isFrontHemisphere(worldPoint: THREE.Vector3, camera: THREE.Camera, globeCenter: THREE.Vector3, threshold = 0.035) {
  const pointNormal = worldPoint.clone().sub(globeCenter).normalize();
  const viewNormal = camera.position.clone().sub(globeCenter).normalize();
  return pointNormal.dot(viewNormal) > threshold;
}

function vectorToGeoPoint(vector: THREE.Vector3): GeoPoint {
  const normalized = vector.clone().normalize();
  const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(normalized.y, -1, 1)));
  const theta = Math.atan2(normalized.z, normalized.x);
  const lng = ((90 - THREE.MathUtils.radToDeg(theta) + 540) % 360) - 180;
  return { lat, lng };
}

function focusQuaternion(point?: GeoPoint) {
  const longitude = point?.lng ?? 33.2;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(-longitude), 0));
}

function cameraTargetForIntent(intent: GlobeViewIntent, fallbackPoint?: GeoPoint) {
  const point = "point" in intent ? intent.point : fallbackPoint;
  const distance =
    intent.source === "timeline-place"
      ? 2.18
      : intent.source === "timeline-trip-entry" || intent.source === "timeline-trip"
        ? 3.85
        : intent.source === "timeline-global"
          ? 6.05
          : 5.25;
  const latitude = point?.lat ?? 18;
  const latitudeStrength = intent.source === "timeline-place" ? 1 : intent.source === "timeline-trip-entry" || intent.source === "timeline-trip" ? 0.82 : 0.58;
  const latitudeClamp = intent.source === "timeline-place" ? 0.96 : 0.78;
  const y = THREE.MathUtils.clamp(Math.sin(THREE.MathUtils.degToRad(latitude)) * distance * latitudeStrength, -distance * latitudeClamp, distance * latitudeClamp);
  const z = Math.sqrt(Math.max(distance * distance - y * y, 0.4));
  return new THREE.Vector3(0, y, z);
}

function toTravelMarker(marker: GlobeMarker, locale: Locale): TravelMarker {
  return {
    id: marker.id,
    kind: marker.kind,
    label: markerLabel(marker, locale),
    center: marker.center,
    count: marker.count,
    photoIds: marker.photoIds,
    placeIds: marker.placeIds,
    tripId: marker.tripId,
    countryName: countryLabel(marker.countryNames, marker.countryName, locale),
    startTime: marker.startTime,
    endTime: marker.endTime,
    active: false,
  };
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

  return (
    <>
      {lines.map((line) => (
        <TravelRouteSegment key={line.id} line={line} />
      ))}
    </>
  );
}

function TravelRouteSegment({
  line,
}: {
  line: {
    id: string;
    active: boolean;
    crossCountry: boolean;
    longHop: boolean;
    points: [number, number, number][];
    arrowPosition: [number, number, number];
    arrowDirectionPoint: [number, number, number];
  };
}) {
  const camera = useThree((state) => state.camera);
  const lineRef = useRef<Line2 | LineSegments2 | null>(null);

  useFrame(() => {
    const zoom = zoomProgress(camera);
    const intraCountryOpacity = smoothstep(0.34, 0.6, zoom) * 0.88;
    const crossCountryOpacity = THREE.MathUtils.lerp(0.92, 0.62, smoothstep(0.45, 0.82, zoom));
    const routeOpacity = line.crossCountry ? crossCountryOpacity : intraCountryOpacity;
    const opacity = line.active ? Math.max(routeOpacity, 0.72) : routeOpacity;
    const route = lineRef.current;
    const material = Array.isArray(route?.material) ? route?.material[0] : route?.material;
    if (route) route.visible = opacity >= 0.025;
    if (material) {
      material.transparent = true;
      material.opacity = opacity;
    }
  });

  return (
    <group>
      <Line
        ref={lineRef}
        points={line.points}
        color={ROUTE_LONG_HOP}
        lineWidth={line.active ? 3.5 : line.longHop ? 3.05 : 2.45}
        transparent
        opacity={0}
        depthWrite={false}
        depthTest
        renderOrder={12}
      />
      <RouteArrow color={ROUTE_ARROW} directionPoint={line.arrowDirectionPoint} position={line.arrowPosition} />
    </group>
  );
}

function RouteArrow({
  color,
  directionPoint,
  position,
}: {
  color: string;
  directionPoint: [number, number, number];
  position: [number, number, number];
}) {
  const camera = useThree((state) => state.camera);
  const anchorRef = useRef<THREE.Group>(null);
  const arrowRef = useRef<HTMLSpanElement>(null);
  const localStart = useMemo(() => new THREE.Vector3(...position), [position]);
  const localEnd = useMemo(() => new THREE.Vector3(...directionPoint), [directionPoint]);
  const screenStartRef = useRef(new THREE.Vector3());
  const screenEndRef = useRef(new THREE.Vector3());

  useFrame(() => {
    const parent = anchorRef.current?.parent;
    if (!parent || !arrowRef.current) return;

    const worldStart = screenStartRef.current.copy(localStart).applyMatrix4(parent.matrixWorld);
    const worldEnd = screenEndRef.current.copy(localEnd).applyMatrix4(parent.matrixWorld);
    const globeCenter = parent.localToWorld(new THREE.Vector3(0, 0, 0));
    const isFrontFacing = isFrontHemisphere(worldStart, camera, globeCenter);
    const screenStart = worldStart.project(camera);
    const screenEnd = worldEnd.project(camera);
    const dx = screenEnd.x - screenStart.x;
    const dy = screenStart.y - screenEnd.y;
    if (Math.hypot(dx, dy) < 0.0001) return;
    const arrowOpacity = smoothstep(0.68, 0.84, zoomProgress(camera));
    arrowRef.current.style.opacity = isFrontFacing && arrowOpacity > 0.02 ? String(arrowOpacity) : "0";
    arrowRef.current.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  });

  return (
    <group ref={anchorRef}>
      <Html center position={position} zIndexRange={[32, 14]} transform={false}>
        <span ref={arrowRef} className="travel-route-arrow" style={{ color, opacity: 0 }} />
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
      roughness: 0.82,
      metalness: 0.03,
      emissive: "#d8c8b9",
      emissiveIntensity: 0.18,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
    });

    globe.globeMaterial(material).showAtmosphere(true).atmosphereColor("#f7dcc0").atmosphereAltitude(0.1);
  }, [globe]);

  return <primitive object={globe} />;
}

function GlobeRimLayer() {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const camera = useThree((state) => state.camera);

  useFrame(() => {
    if (!materialRef.current) return;
    const zoom = zoomProgress(camera);
    materialRef.current.uniforms.uOpacity.value = THREE.MathUtils.lerp(0.28, 0.18, smoothstep(0.25, 0.9, zoom));
  });

  return (
    <mesh renderOrder={8}>
      <sphereGeometry args={[GLOBE_RADIUS * 1.006, 96, 96]} />
      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        depthTest={false}
        blending={THREE.NormalBlending}
        uniforms={{
          uColor: { value: new THREE.Color(GLOBE_RIM) },
          uOpacity: { value: 0.24 },
        }}
        vertexShader={`
          varying vec3 vNormal;
          varying vec3 vWorldPosition;

          void main() {
            vNormal = normalize(mat3(modelMatrix) * normal);
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `}
        fragmentShader={`
          uniform vec3 uColor;
          uniform float uOpacity;
          varying vec3 vNormal;
          varying vec3 vWorldPosition;

          void main() {
            vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
            float rim = 1.0 - max(dot(normalize(vNormal), viewDirection), 0.0);
            float alpha = smoothstep(0.28, 0.78, rim) * uOpacity;
            gl_FragColor = vec4(uColor, alpha);
          }
        `}
      />
    </mesh>
  );
}

function GlobeRouteOcclusionLayer() {
  return (
    <mesh renderOrder={11}>
      <sphereGeometry args={[GLOBE_RADIUS * 1.002, 96, 96]} />
      <meshBasicMaterial colorWrite={false} depthTest depthWrite />
    </mesh>
  );
}

function BillboardMarker({
  marker,
  pointPicking,
  onSelect,
}: {
  marker: TravelMarker;
  pointPicking: boolean;
  onSelect: (marker: TravelMarker) => void;
}) {
  const camera = useThree((state) => state.camera);
  const anchorRef = useRef<THREE.Group>(null);
  const markerRef = useRef<HTMLButtonElement>(null);
  const opacityRef = useRef(-1);
  const localPosition = useMemo(() => threeGlobeVector(marker.center, GLOBE_RADIUS, MARKER_ALTITUDE), [marker.center]);
  const position = useMemo(() => localPosition.toArray(), [localPosition]);

  useFrame(() => {
    const element = markerRef.current;
    if (!element) return;
    const parent = anchorRef.current?.parent;
    const globeCenter = parent?.localToWorld(new THREE.Vector3(0, 0, 0));
    const worldPosition = parent ? localPosition.clone().applyMatrix4(parent.matrixWorld) : localPosition;
    const isFacingCamera = globeCenter ? isFrontHemisphere(worldPosition, camera, globeCenter) : true;
    const zoom = zoomProgress(camera);
    const countryOpacity = 1 - smoothstep(0.28, 0.56, zoom);
    const placeOpacity = smoothstep(0.28, 0.56, zoom);
    const lodOpacity = isFacingCamera ? (marker.kind === "country" ? countryOpacity : placeOpacity) : 0;
    if (Math.abs(opacityRef.current - lodOpacity) < 0.008) return;
    opacityRef.current = lodOpacity;
    const isInteractive =
      isFacingCamera &&
      !pointPicking &&
      (marker.kind === "country"
        ? countryOpacity > MARKER_INTERACTIVE_OPACITY
        : placeOpacity > MARKER_INTERACTIVE_OPACITY && countryOpacity <= PLACE_MARKER_INTERACTIVE_COUNTRY_OPACITY);
    element.style.opacity = String(lodOpacity);
    element.style.pointerEvents = isInteractive ? "auto" : "none";
    element.dataset.interactive = String(isInteractive);
  });

  return (
    <group ref={anchorRef}>
    <Html
      center
      className="travel-marker-anchor"
      position={position}
      zIndexRange={marker.kind === "country" ? [90, 70] : [40, 20]}
      transform={false}
      style={{ pointerEvents: "none" }}
    >
      <button
        ref={markerRef}
        className={`travel-marker travel-marker--${marker.kind}${marker.active ? " is-selected" : ""}${marker.routeRole ? ` is-${marker.routeRole}` : ""}`}
        style={{ opacity: 0, pointerEvents: "none" }}
        data-marker-kind={marker.kind}
        data-marker-label={marker.label}
        aria-label={markerLabel(marker)}
        title={markerLabel(marker)}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onSelect(marker);
        }}
      >
        {marker.kind === "country" ? null : <span className="travel-marker-dot" />}
      </button>
    </Html>
    </group>
  );
}

function GlobePointPicker({ enabled, onPick }: { enabled: boolean; onPick: (point: GeoPoint) => void }) {
  const pointerStart = useRef<{ x: number; y: number }>();

  if (!enabled) return null;

  return (
    <mesh
      renderOrder={30}
      onPointerDown={(event) => {
        pointerStart.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        const start = pointerStart.current;
        pointerStart.current = undefined;
        if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
        event.stopPropagation();
        onPick(vectorToGeoPoint(event.object.worldToLocal(event.point.clone())));
      }}
      onPointerCancel={() => {
        pointerStart.current = undefined;
      }}
    >
      <sphereGeometry args={[GLOBE_RADIUS * 1.008, 96, 96]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  );
}

function GlobeScene({
  markers,
  paths,
  selectedMarker,
  trip,
  photos,
  isAnnotationClosing,
  focusPoint,
  viewIntent,
  pointPicking,
  onManualView,
  onOpenArchive,
  onOpenPhoto,
  onPickPoint,
  onSelect,
}: {
  markers: TravelMarker[];
  paths: GlobePath[];
  selectedMarker?: TravelMarker;
  trip?: Trip;
  photos: Photo[];
  isAnnotationClosing: boolean;
  focusPoint?: GeoPoint;
  viewIntent: GlobeViewIntent;
  pointPicking: boolean;
  onManualView: () => void;
  onOpenArchive: () => void;
  onOpenPhoto: (photo: Photo) => void;
  onPickPoint: (point: GeoPoint) => void;
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

  useFrame((_, delta) => {
    if (controlsRef.current) {
      const targetRotateSpeed = orbitRotateSpeed(camera);
      const response = targetRotateSpeed < controlsRef.current.rotateSpeed ? 1 - Math.exp(-32 * delta) : 1 - Math.exp(-10 * delta);
      controlsRef.current.rotateSpeed = THREE.MathUtils.lerp(controlsRef.current.rotateSpeed, targetRotateSpeed, response);
    }

    if (viewIntent.source !== "manual") {
      const rotationStep = 1 - Math.exp(-3.1 * delta);
      const cameraStep = 1 - Math.exp(-3.8 * delta);
      const targetStep = 1 - Math.exp(-10.4 * delta);
      if (groupRef.current) groupRef.current.quaternion.slerp(targetQuaternion.current, rotationStep);
      camera.position.lerp(targetCameraPosition.current, cameraStep);
      camera.up.set(0, 1, 0);
      controlsRef.current?.target.lerp(globeCenter, targetStep);
      camera.lookAt(globeCenter);
      controlsRef.current?.update();
    }
  });

  const handleManualStart = () => {
    if (controlsRef.current) controlsRef.current.rotateSpeed = orbitRotateSpeed(camera);
    onManualView();
  };

  return (
    <>
      <ambientLight intensity={1.95} />
      <directionalLight position={[3, 4, 5]} intensity={1.35} color="#d9f6ff" />
      <pointLight position={[-4, -2, 3]} color="#ff7aa8" intensity={1.55} />
      <group ref={groupRef} scale={GLOBE_SCALE}>
        <ThreeGlobeLayer />
        <GlobeRimLayer />
        <LandParticleLayer />
        <MediumLandParticleLayer />
        <NearLandParticleLayer />
        <AssetLineLayer kind="coastLine" color={COAST_LINE} baseOpacity={0.5} renderOrder={5} />
        <AssetLineLayer kind="countryLine" color={COUNTRY_BOUNDARY_LINE} baseOpacity={0.36} renderOrder={6} />
        <AssetLineLayer kind="provinceLine" color={PROVINCE_BOUNDARY_LINE} baseOpacity={0.44} renderOrder={7} />
        <GlobeRouteOcclusionLayer />
        <TravelRouteLayer paths={paths} />
        <GlobePointPicker enabled={pointPicking} onPick={onPickPoint} />
        {markers.map((marker) => (
          <BillboardMarker key={marker.id} marker={marker} pointPicking={pointPicking} onSelect={onSelect} />
        ))}
        <TravelMapAnnotation
          selected={selectedMarker}
          trip={trip}
          photos={photos}
          isClosing={isAnnotationClosing}
          onOpenArchive={onOpenArchive}
          onOpenPhoto={onOpenPhoto}
        />
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

function TravelMapAnnotation({
  selected,
  trip,
  photos,
  isClosing,
  onOpenArchive,
  onOpenPhoto,
}: {
  selected?: TravelMarker;
  trip?: Trip;
  photos: Photo[];
  isClosing: boolean;
  onOpenArchive: () => void;
  onOpenPhoto: (photo: Photo) => void;
}) {
  const { t } = useI18n();
  const photoStripRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<THREE.Group>(null);
  const noteRef = useRef<HTMLElement | null>(null);
  const photoDragRef = useRef({ isDragging: false, lastX: 0, moved: false, pointerId: -1, startX: 0 });
  const photoStripTimer = useRef<number | undefined>(undefined);
  const [showPhotoStrip, setShowPhotoStrip] = useState(false);
  const camera = useThree((state) => state.camera);
  const localPosition = useMemo(() => (selected ? threeGlobeVector(selected.center, GLOBE_RADIUS, MARKER_ALTITUDE) : undefined), [selected]);
  const position = useMemo(() => localPosition?.toArray(), [localPosition]);

  useEffect(() => {
    window.clearTimeout(photoStripTimer.current);
    setShowPhotoStrip(false);
    if (!selected || isClosing) return undefined;

    photoStripTimer.current = window.setTimeout(() => setShowPhotoStrip(true), 520);
    return () => window.clearTimeout(photoStripTimer.current);
  }, [isClosing, selected?.id]);

  useFrame(() => {
    if (!localPosition || !noteRef.current) return;
    const parent = anchorRef.current?.parent;
    const globeCenter = parent?.localToWorld(new THREE.Vector3(0, 0, 0));
    const worldPosition = parent ? localPosition.clone().applyMatrix4(parent.matrixWorld) : localPosition;
    const isFacingCamera = globeCenter ? isFrontHemisphere(worldPosition, camera, globeCenter) : true;
    noteRef.current.style.visibility = isFacingCamera ? "visible" : "hidden";
    noteRef.current.style.pointerEvents = isFacingCamera ? "auto" : "none";
  });

  if (!selected || !trip || !position) return null;

  const relatedPhotos = photos.filter((photo) => selected.photoIds.includes(photo.id));

  const handlePhotoStripWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const strip = photoStripRef.current;
    if (!strip) return;

    const canScroll = strip.scrollWidth > strip.clientWidth;
    if (!canScroll) return;

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;

    event.preventDefault();
    strip.scrollLeft += delta;
  };

  const handlePhotoStripPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if ((event.target as HTMLElement | null)?.closest(".travel-photo-thumb")) return;
    const strip = photoStripRef.current;
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;

    photoDragRef.current = {
      isDragging: true,
      lastX: event.clientX,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
    };
    strip.setPointerCapture(event.pointerId);
  };

  const handlePhotoStripPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const strip = photoStripRef.current;
    const drag = photoDragRef.current;
    if (!strip || !drag.isDragging) return;

    const movement = event.clientX - drag.lastX;
    const distance = Math.abs(event.clientX - drag.startX);
    if (distance > 5) drag.moved = true;
    drag.lastX = event.clientX;
    strip.scrollLeft -= movement;
  };

  const finishPhotoStripDrag = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const strip = photoStripRef.current;
    const drag = photoDragRef.current;
    if (strip && drag.pointerId === event.pointerId && strip.hasPointerCapture(event.pointerId)) {
      strip.releasePointerCapture(event.pointerId);
    }
    drag.isDragging = false;
  };

  const openPhotoFromStrip = (photo: Photo) => {
    if (photoDragRef.current.moved) {
      photoDragRef.current.moved = false;
      return;
    }

    onOpenPhoto(photo);
  };

  return (
    <group ref={anchorRef}>
    <Html center position={position} zIndexRange={[72, 44]} transform={false}>
      <aside
        ref={noteRef}
        className="travel-map-note"
        data-kind={selected.kind}
        data-state={isClosing ? "closing" : "open"}
        aria-label={selected.kind === "country" ? countryLabel(selected.countryName) : markerLabel(selected)}
      >
        <span className="travel-map-note-line travel-map-note-line-diagonal" aria-hidden="true" />
        <span className="travel-map-note-line travel-map-note-line-horizontal" aria-hidden="true" />
        <span className="travel-map-note-terminal" aria-hidden="true" />
        <div className="travel-map-note-body">
          {selected.kind === "country" ? (
            <div className="travel-map-note-country-row">
              <h2>{countryLabel(selected.countryName)}</h2>
              <button
                className="travel-map-note-action"
                type="button"
                aria-label={t("enterArchive")}
                title={t("enterArchive")}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenArchive();
                }}
              >
                <Archive size={16} />
              </button>
            </div>
          ) : (
            <>
              <div className="travel-map-note-title-row">
                <h2>{markerLabel(selected)}</h2>
                <button
                  className="travel-map-note-action"
                  type="button"
                  aria-label={t("enterArchive")}
                  title={t("enterArchive")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenArchive();
                  }}
                >
                  <Archive size={16} />
                </button>
              </div>
              {showPhotoStrip && relatedPhotos.length > 0 ? (
                <div
                  ref={photoStripRef}
                  className="travel-photo-strip"
                  aria-label={t("relatedPhotos")}
                  onWheel={handlePhotoStripWheel}
                  onPointerDown={handlePhotoStripPointerDown}
                  onPointerMove={handlePhotoStripPointerMove}
                  onPointerUp={finishPhotoStripDrag}
                  onPointerCancel={finishPhotoStripDrag}
                  onPointerLeave={finishPhotoStripDrag}
                >
                  {relatedPhotos.map((photo) => (
                    <button
                      key={photo.id}
                      type="button"
                      className="travel-photo-thumb"
                      onClick={(event) => {
                        event.stopPropagation();
                        openPhotoFromStrip(photo);
                      }}
                      aria-label={photoLabel(photo)}
                    >
                      <img src={photo.thumbnailUrl} alt={photoAltText(photo)} decoding="async" loading="lazy" />
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </Html>
    </group>
  );
}

function PhotoLightbox({ photo, placeName, onClose }: { photo?: Photo; placeName?: string; onClose: () => void }) {
  const { t } = useI18n();
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [mediaWidth, setMediaWidth] = useState<number>();
  const syncMediaWidth = useCallback(() => {
    window.requestAnimationFrame(() => {
      const width = imageRef.current?.getBoundingClientRect().width;
      if (width && Number.isFinite(width)) setMediaWidth(Math.ceil(width));
    });
  }, []);

  useEffect(() => {
    setMediaWidth(undefined);
  }, [photo?.id]);

  useEffect(() => {
    if (!photo) return undefined;
    syncMediaWidth();
    window.addEventListener("resize", syncMediaWidth);
    return () => window.removeEventListener("resize", syncMediaWidth);
  }, [photo, syncMediaWidth]);

  if (!photo) return null;

  return createPortal(
    <div className="travel-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <figure
        className="travel-lightbox-card"
        onClick={(event) => event.stopPropagation()}
        style={mediaWidth ? ({ "--travel-lightbox-width": `${mediaWidth}px` } as CSSProperties) : undefined}
      >
        <button className="travel-lightbox-close" type="button" aria-label={t("closePhotoPreview")} onClick={onClose}>
          <X size={26} />
        </button>
        <div className="travel-lightbox-media">
          <img ref={imageRef} src={photo.storageUrl ?? photo.thumbnailUrl} alt={photoAltText(photo)} onLoad={syncMediaWidth} />
          <figcaption>
            <strong>{photoLabel(photo)}</strong>
            <span>{formatDate(photo.capturedAt)}</span>
          </figcaption>
        </div>
        <p className="travel-lightbox-caption">{photo.userEdits?.caption ?? photo.aiCaption}</p>
        <span className="sr-only">{placeName ?? placeLabel(undefined)}</span>
      </figure>
    </div>,
    document.body,
  );
}

export function EarthStage() {
  const { t } = useI18n();
  const locale = useAppStore((state) => state.locale);
  const activePanel = useAppStore((state) => state.activePanel);
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const selectedPlaceId = useAppStore((state) => state.selectedPlaceId);
  const timelineZoom = useAppStore((state) => state.timelineZoom);
  const trips = useAppStore((state) => state.trips);
  const placeNodes = useAppStore((state) => state.placeNodes);
  const photos = useAppStore((state) => state.photos);
  const globeMarkers = useAppStore((state) => state.globeMarkers);
  const selectTrip = useAppStore((state) => state.selectTrip);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const globeViewIntent = useAppStore((state) => state.globeViewIntent);
  const setGlobeViewIntent = useAppStore((state) => state.setGlobeViewIntent);
  const manualPlacePick = useAppStore((state) => state.manualPlacePick);
  const finishManualPlacePick = useAppStore((state) => state.finishManualPlacePick);
  const [selectedMapItem, setSelectedMapItem] = useState<SelectedMapItem>();
  const [infoPanelClosing, setInfoPanelClosing] = useState(false);
  const [previewPhoto, setPreviewPhoto] = useState<Photo>();
  const infoPanelCloseTimer = useRef<number | undefined>(undefined);

  const shouldShowAllTrips = timelineZoom === "global";
  const visibleTripId = shouldShowAllTrips ? undefined : selectedTripId;
  const trip = trips.find((item) => item.id === selectedTripId);
  const places = useMemo(() => (visibleTripId ? placeNodes.filter((place) => place.tripId === visibleTripId) : placeNodes), [placeNodes, visibleTripId]);
  const tripPhotos = useMemo(() => (visibleTripId ? photos.filter((photo) => photo.tripId === visibleTripId) : photos), [photos, visibleTripId]);
  const projectedMarkers = useMemo(
    () => globeMarkers.filter((marker) => !visibleTripId || marker.tripId === visibleTripId).map((marker) => toTravelMarker(marker, locale)),
    [globeMarkers, locale, visibleTripId],
  );
  const placeMarkers = useMemo(() => {
    const byTrip = new Map<string, TravelMarker[]>();
    for (const marker of projectedMarkers) {
      if (marker.kind !== "place") continue;
      const tripMarkers = byTrip.get(marker.tripId) ?? [];
      tripMarkers.push(marker);
      byTrip.set(marker.tripId, tripMarkers);
    }
    return Array.from(byTrip.values()).flatMap((tripMarkers) => applyRouteRoles(tripMarkers));
  }, [projectedMarkers]);
  const countryMarkers = useMemo(() => projectedMarkers.filter((marker) => marker.kind === "country"), [projectedMarkers]);
  const selectedMarker = [...countryMarkers, ...placeMarkers].find((marker) => marker.id === selectedMapItem?.id);
  const annotationTrip = selectedMarker ? trips.find((item) => item.id === selectedMarker.tripId) : trip;
  const markers = useMemo(
    () => [...countryMarkers, ...placeMarkers].map((marker) => ({ ...marker, active: marker.id === selectedMapItem?.id || marker.active })),
    [countryMarkers, placeMarkers, selectedMapItem?.id],
  );
  const activeMarker = markers.find((marker) => marker.id === selectedMapItem?.id) ?? markers.find((marker) => marker.active);
  const tripFocusPoint = useMemo(() => (placeMarkers.length ? centerOf(placeMarkers.map((place) => place.center)) : undefined), [placeMarkers]);
  const focusPoint = "point" in globeViewIntent ? globeViewIntent.point : activeMarker?.center ?? tripFocusPoint ?? placeMarkers[0]?.center;
  const paths = useMemo(() => {
    const byTrip = new Map<string, TravelMarker[]>();
    for (const marker of placeMarkers) {
      const tripMarkers = byTrip.get(marker.tripId) ?? [];
      tripMarkers.push(marker);
      byTrip.set(marker.tripId, tripMarkers);
    }
    return Array.from(byTrip.values()).flatMap((tripMarkers) => routePaths(tripMarkers, activeMarker));
  }, [activeMarker, placeMarkers]);
  const previewPlace = previewPhoto?.placeNodeId ? places.find((place) => place.id === previewPhoto.placeNodeId) : undefined;
  const homeState = activePanel === "globe" ? "active" : "covered";
  const pointPicking = Boolean(manualPlacePick?.isPicking);

  const handlePickPoint = useCallback(
    (point: GeoPoint) => {
      void finishManualPlacePick(point);
    },
    [finishManualPlacePick],
  );

  const transitionToMapItem = (item: Exclude<SelectedMapItem, undefined>, options: { waitForExit?: boolean } = {}) => {
    window.clearTimeout(infoPanelCloseTimer.current);
    const waitForExit = options.waitForExit ?? true;

    if (!waitForExit || !selectedMapItem || selectedMapItem.id === item.id) {
      setInfoPanelClosing(false);
      setSelectedMapItem(item);
      return;
    }

    setInfoPanelClosing(true);
    infoPanelCloseTimer.current = window.setTimeout(() => {
      setSelectedMapItem(item);
      setInfoPanelClosing(false);
    }, 240);
  };

  const closeSelectedMapItem = () => {
    if (!selectedMapItem) return;
    window.clearTimeout(infoPanelCloseTimer.current);
    setInfoPanelClosing(true);
    infoPanelCloseTimer.current = window.setTimeout(() => {
      setSelectedMapItem(undefined);
      setInfoPanelClosing(false);
    }, 260);
  };

  useEffect(() => () => window.clearTimeout(infoPanelCloseTimer.current), []);

  useEffect(() => {
    if (!selectedPlaceId) return;
    const marker = placeMarkers.find((item) => item.placeIds?.includes(selectedPlaceId));
    if (marker) transitionToMapItem({ kind: "place", id: marker.id });
  }, [placeMarkers, selectedPlaceId]);

  useEffect(() => {
    if (!selectedPlaceId && selectedMapItem?.kind === "place") closeSelectedMapItem();
  }, [selectedMapItem?.kind, selectedPlaceId]);

  const handleSelect = (marker: TravelMarker) => {
    if (pointPicking) return;
    if (selectedMapItem?.id === marker.id) {
      closeSelectedMapItem();
      return;
    }
    transitionToMapItem({ kind: marker.kind, id: marker.id });
    if (marker.kind === "place" && marker.placeIds?.[0]) selectPlace(marker.placeIds[0]);
  };

  const handleOpenArchive = () => {
    if (selectedMarker?.tripId) {
      selectTrip(selectedMarker.tripId, "tripDetail");
      return;
    }

    setActivePanel("tripDetail");
  };

  return (
    <section className="home-earth-layer relative min-h-screen overflow-hidden" data-home-state={homeState}>
      <div className="pointer-events-none fixed left-1/2 top-1/2 h-[76vmin] w-[76vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-fixed/20 blur-3xl" />
      <div className="three-globe-stage fixed inset-0 z-10 h-screen w-screen">
        <Canvas
          camera={{ position: [0, 0, 5.25], fov: 42, near: 0.1, far: 1000 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          onPointerMissed={() => {
            if (!pointPicking) closeSelectedMapItem();
          }}
        >
          <Suspense fallback={null}>
            <GlobeScene
              markers={markers}
              paths={paths}
              selectedMarker={selectedMarker}
              trip={annotationTrip}
              photos={tripPhotos}
              isAnnotationClosing={infoPanelClosing}
              focusPoint={focusPoint}
              viewIntent={globeViewIntent}
              pointPicking={pointPicking}
              onManualView={() => setGlobeViewIntent({ source: "manual" })}
              onOpenArchive={handleOpenArchive}
              onOpenPhoto={setPreviewPhoto}
              onPickPoint={handlePickPoint}
              onSelect={handleSelect}
            />
          </Suspense>
        </Canvas>
      </div>
      {pointPicking ? (
        <div className="globe-point-pick-hint">
          <MapPin size={15} />
          <strong>{t("pickOnGlobe")}</strong>
          <span>{t("dragToRotateClickToPick")}</span>
        </div>
      ) : null}
      <PhotoLightbox photo={previewPhoto} placeName={placeLabel(previewPlace, locale)} onClose={() => setPreviewPhoto(undefined)} />
    </section>
  );
}
