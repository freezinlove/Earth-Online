import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Archive, X } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import * as THREE from "three";
import ThreeGlobe from "three-globe";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { capturedDateTimeLabel } from "@/domain/datetime";
import { countryLabel, markerLabel, photoAltText, photoLabel, placeLabel } from "@/domain/labels";
import type { GeoPoint, GlobeMarker, Photo, Trip } from "@/domain/models";
import { useAppStore, type GlobeViewIntent } from "@/store/appStore";

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
const GLOBE_SHELL = "#efe1cf";
const LAND_PARTICLE_SIZE = 3.05;
const MEDIUM_LAND_PARTICLE_SIZE = 2.85;
const NEAR_LAND_PARTICLE_SIZE = 2.35;
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

function toTravelMarker(marker: GlobeMarker): TravelMarker {
  return {
    id: marker.id,
    kind: marker.kind,
    label: marker.label,
    center: marker.center,
    count: marker.count,
    photoIds: marker.photoIds,
    placeIds: marker.placeIds,
    tripId: marker.tripId,
    countryName: marker.countryName,
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
  onManualView,
  onOpenArchive,
  onOpenPhoto,
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
  onManualView: () => void;
  onOpenArchive: () => void;
  onOpenPhoto: (photo: Photo) => void;
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
      const targetRotateSpeed = orbitRotateSpeed(camera);
      const response = targetRotateSpeed < controlsRef.current.rotateSpeed ? 0.42 : 0.16;
      controlsRef.current.rotateSpeed = THREE.MathUtils.lerp(controlsRef.current.rotateSpeed, targetRotateSpeed, response);
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
  const photoStripRef = useRef<HTMLDivElement | null>(null);
  const photoDragRef = useRef({ isDragging: false, lastX: 0, moved: false, pointerId: -1, startX: 0 });
  const position = useMemo(() => (selected ? threeGlobeVector(selected.center, GLOBE_RADIUS, MARKER_ALTITUDE).toArray() : undefined), [selected]);

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
    <Html center position={position} zIndexRange={[72, 44]} transform={false}>
      <aside
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
                aria-label="进入档案"
                title="进入档案"
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
                  aria-label="进入档案"
                  title="进入档案"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenArchive();
                  }}
                >
                  <Archive size={16} />
                </button>
              </div>
              {relatedPhotos.length > 0 ? (
                <div
                  ref={photoStripRef}
                  className="travel-photo-strip"
                  aria-label="相关照片"
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
                      <img src={photo.thumbnailUrl} alt={photoAltText(photo)} />
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </aside>
    </Html>
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
        <img src={photo.storageUrl ?? photo.thumbnailUrl} alt={photoAltText(photo)} />
        <div>
          <p>{formatDate(photo.capturedAt)}</p>
          <h3>{photoLabel(photo)}</h3>
          <span>{placeName ?? placeLabel(undefined)}</span>
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
  const globeMarkers = useAppStore((state) => state.globeMarkers);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const setActivePanel = useAppStore((state) => state.setActivePanel);
  const globeViewIntent = useAppStore((state) => state.globeViewIntent);
  const setGlobeViewIntent = useAppStore((state) => state.setGlobeViewIntent);
  const [selectedMapItem, setSelectedMapItem] = useState<SelectedMapItem>();
  const [infoPanelClosing, setInfoPanelClosing] = useState(false);
  const [previewPhoto, setPreviewPhoto] = useState<Photo>();
  const infoPanelCloseTimer = useRef<number | undefined>(undefined);

  const trip = trips.find((item) => item.id === selectedTripId);
  const places = useMemo(() => placeNodes.filter((place) => place.tripId === selectedTripId), [placeNodes, selectedTripId]);
  const tripPhotos = useMemo(() => photos.filter((photo) => photo.tripId === selectedTripId), [photos, selectedTripId]);
  const projectedMarkers = useMemo(() => globeMarkers.filter((marker) => marker.tripId === selectedTripId).map(toTravelMarker), [globeMarkers, selectedTripId]);
  const placeMarkers = useMemo(() => applyRouteRoles(projectedMarkers.filter((marker) => marker.kind === "place")), [projectedMarkers]);
  const countryMarkers = useMemo(() => projectedMarkers.filter((marker) => marker.kind === "country"), [projectedMarkers]);
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

  const transitionToMapItem = (item: Exclude<SelectedMapItem, undefined>) => {
    window.clearTimeout(infoPanelCloseTimer.current);

    if (!selectedMapItem || selectedMapItem.id === item.id) {
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
    if (selectedMapItem?.id === marker.id) {
      closeSelectedMapItem();
      return;
    }
    transitionToMapItem({ kind: marker.kind, id: marker.id });
    if (marker.kind === "place" && marker.placeIds?.[0]) selectPlace(marker.placeIds[0]);
  };

  return (
    <section className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none fixed left-1/2 top-1/2 h-[76vmin] w-[76vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-fixed/20 blur-3xl" />
      <div className="three-globe-stage fixed inset-0 z-10 h-screen w-screen">
        <Canvas camera={{ position: [0, 0, 5.25], fov: 42, near: 0.1, far: 1000 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }} onPointerMissed={closeSelectedMapItem}>
          <Suspense fallback={null}>
            <GlobeScene
              markers={markers}
              paths={paths}
              selectedMarker={selectedMarker}
              trip={trip}
              photos={tripPhotos}
              isAnnotationClosing={infoPanelClosing}
              focusPoint={focusPoint}
              viewIntent={globeViewIntent}
              onManualView={() => setGlobeViewIntent({ source: "manual" })}
              onOpenArchive={() => setActivePanel("tripDetail")}
              onOpenPhoto={setPreviewPhoto}
              onSelect={handleSelect}
            />
          </Suspense>
        </Canvas>
      </div>
      <PhotoLightbox photo={previewPhoto} placeName={previewPlace?.name} onClose={() => setPreviewPhoto(undefined)} />
    </section>
  );
}
