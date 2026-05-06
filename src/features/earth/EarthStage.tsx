import { Html, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import ThreeGlobe from "three-globe";
import type { GeoPoint, Photo, PlaceNode, Route } from "@/domain/models";
import { useAppStore } from "@/store/appStore";

type GlobePoint = {
  id: string;
  kind: "place" | "photo";
  label: string;
  center: GeoPoint;
  count?: number;
  active: boolean;
};

type GlobePath = {
  id: string;
  points: Array<GeoPoint & { alt?: number }>;
  color: string;
  stroke: number;
};

const GLOBE_RADIUS = 100;
const GLOBE_SCALE = 0.0185;
const MARKER_ALTITUDE = 1.9;
const TERRACOTTA = "#a4471f";
const TERRACOTTA_DARK = "#7d2f0f";
const GOLD = "#f0b34d";
const SAGE = "#5c692c";

function routeDistance(start: GeoPoint, end: GeoPoint) {
  const lat1 = (start.lat * Math.PI) / 180;
  const lat2 = (end.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((end.lng - start.lng) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routePaths(route?: Route): GlobePath[] {
  if (!route || route.points.length < 2) return [];

  return route.points.slice(0, -1).map((point, index) => {
    const next = route.points[index + 1];
    const distance = routeDistance(point, next);
    const shortHop = distance < 0.12;
    const midAlt = shortHop ? 0.002 : Math.min(0.16, 0.025 + distance * 0.09);
    return {
      id: `${route.id}-${index}`,
      color: shortHop ? TERRACOTTA_DARK : SAGE,
      stroke: shortHop ? 1.1 : 1.45,
      points: [
        { ...point, alt: 0.006 },
        { lat: (point.lat + next.lat) / 2, lng: (point.lng + next.lng) / 2, alt: midAlt },
        { ...next, alt: 0.006 },
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
  const target = new THREE.Quaternion();
  if (!point) return target.setFromEuler(new THREE.Euler(0.08, -0.58, 0));
  const position = threeGlobeVector(point);
  return target.setFromUnitVectors(position.normalize(), new THREE.Vector3(0, 0, 1));
}

function ThreeGlobeLayer({ paths }: { paths: GlobePath[] }) {
  const globe = useMemo(
    () =>
      new ThreeGlobe({
        waitForGlobeReady: true,
        animateIn: false,
      }),
    [],
  );

  useEffect(() => {
    const material = new THREE.MeshStandardMaterial({
      color: "#f6e6cf",
      roughness: 0.74,
      metalness: 0.03,
      emissive: "#3a1d0d",
      emissiveIntensity: 0.045,
    });

    globe
      .globeImageUrl("/assets/earth_bmng_topography_5400.jpg")
      .bumpImageUrl("/assets/earth_bmng_topography_5400.jpg")
      .globeMaterial(material)
      .showAtmosphere(true)
      .atmosphereColor("#ffd79d")
      .atmosphereAltitude(0.11);
  }, [globe]);

  useEffect(() => {
    globe
      .pathsData(paths)
      .pathPoints("points")
      .pathPointLat((point) => (point as GeoPoint).lat)
      .pathPointLng((point) => (point as GeoPoint).lng)
      .pathPointAlt((point) => (point as { alt?: number }).alt ?? 0.004)
      .pathColor("color")
      .pathStroke("stroke")
      .pathResolution(4)
      .pathTransitionDuration(450);
  }, [globe, paths]);

  return <primitive object={globe} />;
}

function GlobeMarker({
  point,
  onSelect,
}: {
  point: GlobePoint;
  onSelect: (point: GlobePoint) => void;
}) {
  const markerRef = useRef<THREE.Mesh>(null);
  const position = useMemo(() => threeGlobeVector(point.center, GLOBE_RADIUS, MARKER_ALTITUDE / GLOBE_RADIUS).toArray(), [point.center]);
  const markerRadius = point.kind === "place" ? (point.active ? 1.15 : 0.92) : point.active ? 0.72 : 0.56;
  const color = point.active ? GOLD : point.kind === "place" ? TERRACOTTA : "#f7cf8c";

  useFrame(({ clock }) => {
    if (!markerRef.current || !point.active) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 3.5) * 0.08;
    markerRef.current.scale.setScalar(pulse);
  });

  return (
    <group position={position}>
      <mesh
        ref={markerRef}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(point);
        }}
      >
        <sphereGeometry args={[markerRadius, 20, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.18} roughness={0.42} />
      </mesh>
      {point.active ? (
        <Html center distanceFactor={9.5} position={[0, markerRadius + 3.2, 0]} zIndexRange={[30, 10]}>
          <button
            className="three-globe-label"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(point);
            }}
          >
            <span>{point.label}</span>
            {point.count ? <strong>{point.count}</strong> : null}
          </button>
        </Html>
      ) : null}
    </group>
  );
}

function GlobeScene({
  points,
  paths,
  focusPoint,
  onSelect,
}: {
  points: GlobePoint[];
  paths: GlobePath[];
  focusPoint?: GeoPoint;
  onSelect: (point: GlobePoint) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const targetQuaternion = useRef(focusQuaternion(focusPoint));

  useEffect(() => {
    targetQuaternion.current = focusQuaternion(focusPoint);
    groupRef.current?.quaternion.copy(targetQuaternion.current);
  }, [focusPoint]);

  useFrame(() => {
    if (!groupRef.current) return;
    groupRef.current.quaternion.slerp(targetQuaternion.current, 0.045);
  });

  return (
    <>
      <ambientLight intensity={1.95} />
      <directionalLight position={[3, 4, 5]} intensity={1.8} />
      <pointLight position={[-4, -2, 3]} color="#ffd9a8" intensity={1.4} />
      <group ref={groupRef} scale={GLOBE_SCALE}>
        <ThreeGlobeLayer paths={paths} />
        {points.map((point) => (
          <GlobeMarker key={point.id} point={point} onSelect={onSelect} />
        ))}
      </group>
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        enablePan={false}
        rotateSpeed={0.58}
        zoomSpeed={0.8}
        minDistance={2.05}
        maxDistance={6.8}
        target={[0, 0, 0]}
      />
    </>
  );
}

function buildPoints(places: PlaceNode[], photos: Photo[], selectedPlaceId?: string, selectedPhotoId?: string): GlobePoint[] {
  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId);
  const photoPoints = photos
    .filter((photo) => photo.location)
    .map((photo) => ({
      id: `photo-${photo.id}`,
      kind: "photo" as const,
      label: photo.title ?? photo.fileName,
      center: photo.location!,
      active: photo.id === selectedPhotoId,
    }));

  const placePoints = places.map((place) => ({
    id: `place-${place.id}`,
    kind: "place" as const,
    label: place.name,
    center: place.center,
    count: place.photoIds.length,
    active: place.id === selectedPlaceId || selectedPhoto?.placeNodeId === place.id,
  }));

  return [...placePoints, ...photoPoints];
}

export function EarthStage() {
  const selectedTripId = useAppStore((state) => state.selectedTripId);
  const selectedPlaceId = useAppStore((state) => state.selectedPlaceId);
  const selectedPhotoId = useAppStore((state) => state.selectedPhotoId);
  const placeNodes = useAppStore((state) => state.placeNodes);
  const photos = useAppStore((state) => state.photos);
  const routes = useAppStore((state) => state.routes);
  const selectPlace = useAppStore((state) => state.selectPlace);
  const selectPhoto = useAppStore((state) => state.selectPhoto);

  const places = useMemo(() => placeNodes.filter((place) => place.tripId === selectedTripId), [placeNodes, selectedTripId]);
  const tripPhotos = useMemo(() => photos.filter((photo) => photo.tripId === selectedTripId && photo.location), [photos, selectedTripId]);
  const route = useMemo(() => routes.find((item) => item.tripId === selectedTripId), [routes, selectedTripId]);
  const selectedPlace = places.find((place) => place.id === selectedPlaceId);
  const selectedPhoto = tripPhotos.find((photo) => photo.id === selectedPhotoId);
  const focusPoint = selectedPhoto?.location ?? selectedPlace?.center ?? places[0]?.center;

  const points = useMemo(() => buildPoints(places, tripPhotos, selectedPlaceId, selectedPhotoId), [places, selectedPlaceId, selectedPhotoId, tripPhotos]);
  const paths = useMemo(() => routePaths(route), [route]);

  const handleSelect = (point: GlobePoint) => {
    if (point.kind === "photo") {
      selectPhoto(point.id.replace(/^photo-/, ""));
      return;
    }
    selectPlace(point.id.replace(/^place-/, ""));
  };

  return (
    <section className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none fixed left-1/2 top-1/2 h-[76vmin] w-[76vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-fixed/20 blur-3xl" />
      <div className="three-globe-stage fixed inset-0 z-10 h-screen w-screen">
        <Canvas
          camera={{ position: [0, 0, 5.25], fov: 42, near: 0.1, far: 1000 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
        >
          <Suspense fallback={null}>
            <GlobeScene points={points} paths={paths} focusPoint={focusPoint} onSelect={handleSelect} />
          </Suspense>
        </Canvas>
      </div>
    </section>
  );
}
