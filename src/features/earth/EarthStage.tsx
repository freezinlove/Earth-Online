import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import ThreeGlobe from "three-globe";
import type { GeoPoint, Photo, PlaceNode, Route } from "@/domain/models";
import { useAppStore } from "@/store/appStore";
import { buildCountryBoundarySegments, buildLandParticles } from "@/features/earth/worldData";

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
const MEMORY_CORAL = "#ff6b7a";
const MEMORY_BLUE = "#3ddcff";
const MEMORY_GOLD = "#ffd166";
const ROUTE_VIOLET = "#9b7cff";

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
      color: shortHop ? MEMORY_BLUE : ROUTE_VIOLET,
      stroke: shortHop ? 1.25 : 1.65,
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

function LandParticleLayer() {
  const geometry = useMemo(() => {
    const particles = buildLandParticles();
    const positions = new Float32Array(particles.length * 3);
    const colors = new Float32Array(particles.length * 3);
    const dimColor = new THREE.Color("#17233d");

    particles.forEach((particle, index) => {
      const position = threeGlobeVector(particle, GLOBE_RADIUS, 0.010 + particle.revealAt * 0.006);
      const color = new THREE.Color(particle.color).lerp(dimColor, 0.34 + particle.revealAt * 0.22);
      positions.set(position.toArray(), index * 3);
      colors.set(color.toArray(), index * 3);
    });

    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    nextGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return nextGeometry;
  }, []);

  const materialRef = useRef<THREE.PointsMaterial>(null);
  const pointTexture = useMemo(() => createPointTexture(), []);

  useFrame(({ clock }) => {
    if (!materialRef.current) return;
    materialRef.current.opacity = 0.78 + Math.sin(clock.elapsedTime * 0.7) * 0.05;
  });

  return (
    <points geometry={geometry}>
      <pointsMaterial
        ref={materialRef}
        map={pointTexture}
        alphaTest={0.08}
        size={0.075}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.78}
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </points>
  );
}

function CountryBoundaryLayer() {
  const geometry = useMemo(() => {
    const segments = buildCountryBoundarySegments();
    const positions = new Float32Array(segments.length * 2 * 3);

    segments.forEach((segment, index) => {
      const start = threeGlobeVector(segment.start, GLOBE_RADIUS, 0.015);
      const end = threeGlobeVector(segment.end, GLOBE_RADIUS, 0.015);
      positions.set(start.toArray(), index * 6);
      positions.set(end.toArray(), index * 6 + 3);
    });

    const nextGeometry = new THREE.BufferGeometry();
    nextGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return nextGeometry;
  }, []);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#65d6ff" transparent opacity={0.34} depthWrite={false} blending={THREE.AdditiveBlending} />
    </lineSegments>
  );
}

function TravelRouteLayer({ paths }: { paths: GlobePath[] }) {
  const lines = useMemo(
    () =>
      paths.map((path) => {
        const controlPoints = path.points.map((point) => threeGlobeVector(point, GLOBE_RADIUS, point.alt ?? 0.006));
        const curve = new THREE.CatmullRomCurve3(controlPoints);
        return {
          id: path.id,
          color: path.color,
          points: curve.getPoints(32).map((point) => point.toArray() as [number, number, number]),
        };
      }),
    [paths],
  );

  return (
    <>
      {lines.map((line) => (
        <Line key={line.id} points={line.points} color={line.color} lineWidth={2.2} transparent opacity={0.94} depthWrite={false} />
      ))}
    </>
  );
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
      color: "#070b16",
      roughness: 0.64,
      metalness: 0.03,
      emissive: "#0d1830",
      emissiveIntensity: 0.42,
    });

    globe
      .globeMaterial(material)
      .showAtmosphere(true)
      .atmosphereColor("#4cc9ff")
      .atmosphereAltitude(0.14);
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
  const markerRadius = point.kind === "place" ? (point.active ? 1.2 : 0.88) : point.active ? 0.72 : 0.5;
  const color = point.active ? MEMORY_GOLD : point.kind === "place" ? MEMORY_CORAL : MEMORY_BLUE;

  useFrame(({ clock }) => {
    if (!markerRef.current || !point.active) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 3.5) * 0.08;
    markerRef.current.scale.setScalar(pulse);
  });

  return (
    <group position={position}>
      <mesh scale={point.active ? 2.8 : 2.05}>
        <sphereGeometry args={[markerRadius, 24, 24]} />
        <meshBasicMaterial color={color} transparent opacity={point.active ? 0.16 : 0.1} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh
        ref={markerRef}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(point);
        }}
      >
        <sphereGeometry args={[markerRadius, 20, 20]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.82} roughness={0.36} />
      </mesh>
      {point.active ? (
        <Html center distanceFactor={5.6} position={[0, markerRadius + 3.2, 0]} zIndexRange={[30, 10]}>
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
      <directionalLight position={[3, 4, 5]} intensity={1.35} color="#d9f6ff" />
      <pointLight position={[-4, -2, 3]} color="#ff7aa8" intensity={1.55} />
      <group ref={groupRef} scale={GLOBE_SCALE}>
        <ThreeGlobeLayer paths={paths} />
        <LandParticleLayer />
        <CountryBoundaryLayer />
        <TravelRouteLayer paths={paths} />
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
