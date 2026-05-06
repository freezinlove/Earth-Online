import { geoContains } from "d3-geo";
import { feature, mesh } from "topojson-client";
import countriesTopology from "world-atlas/countries-110m.json";
import landTopology from "world-atlas/land-110m.json";
import type { GeoPoint } from "@/domain/models";

type TopologyObject = {
  objects: Record<string, unknown>;
};

type LineStringGeometry = {
  type: "LineString";
  coordinates: number[][];
};

type MultiLineStringGeometry = {
  type: "MultiLineString";
  coordinates: number[][][];
};

export type LandParticle = GeoPoint & {
  revealAt: number;
};

export type GeoLine = GeoPoint[];

let landParticleCache: LandParticle[] | undefined;
let mediumLandParticleCache: LandParticle[] | undefined;
let coastParticleCache: LandParticle[] | undefined;
let countryBoundaryParticleCache: LandParticle[] | undefined;
let coastLineCache: GeoLine[] | undefined;
let countryBoundaryLineCache: GeoLine[] | undefined;

function hash(seed: number) {
  return Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
}

function topoObject(topology: TopologyObject, key: string) {
  const object = topology.objects[key];
  if (!object) throw new Error(`Missing TopoJSON object: ${key}`);
  return object;
}

function buildLandParticleGrid(step: number, revealStart: number, revealRange: number) {
  const topology = landTopology as TopologyObject;
  const land = feature(topology as never, topoObject(topology, "land") as never) as unknown as Parameters<typeof geoContains>[0];
  const particles: LandParticle[] = [];

  for (let lat = -58; lat <= 83; lat += step) {
    const latitudeFactor = Math.max(0.34, Math.cos((lat * Math.PI) / 180));
    const lngStep = (step * 1.24) / latitudeFactor;

    for (let lng = -180; lng <= 180; lng += lngStep) {
      const seed = (lat + 91.7) * 1000 + lng * 7.31;
      const jitterLat = (hash(seed) - 0.5) * step * 0.38;
      const jitterLng = (hash(seed + 13.37) - 0.5) * lngStep * 0.38;
      const point: [number, number] = [lng + jitterLng, lat + jitterLat];

      if (!geoContains(land, point)) continue;

      particles.push({
        lat: point[1],
        lng: point[0],
        revealAt: revealStart + hash(seed + 5.9) * revealRange,
      });
    }
  }

  return particles;
}

export function buildLandParticles() {
  if (landParticleCache) return landParticleCache;

  landParticleCache = buildLandParticleGrid(0.9, 0.08, 0.52);
  return landParticleCache;
}

export function buildMediumLandParticles() {
  if (mediumLandParticleCache) return mediumLandParticleCache;

  mediumLandParticleCache = buildLandParticleGrid(0.48, 0.34, 0.52);
  return mediumLandParticleCache;
}

export function buildCountryBoundaryParticles() {
  if (countryBoundaryParticleCache) return countryBoundaryParticleCache;

  const lines = buildCountryBoundaryLines();
  const particles: LandParticle[] = [];

  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      const start = line[index];
      const end = line[index + 1];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(end.lng - start.lng), Math.abs(end.lat - start.lat)) / 0.42));
      for (let step = 0; step <= steps; step += 1) {
        const progress = step / steps;
        particles.push({
          lat: start.lat + (end.lat - start.lat) * progress,
          lng: start.lng + (end.lng - start.lng) * progress,
          revealAt: 0,
        });
      }
    }
  }

  countryBoundaryParticleCache = particles;
  return particles;
}

export function buildCountryBoundaryLines() {
  if (countryBoundaryLineCache) return countryBoundaryLineCache;

  const topology = countriesTopology as TopologyObject;
  const countryMesh = mesh(
    topology as never,
    topoObject(topology, "countries") as never,
    (left, right) => left !== right,
  ) as LineStringGeometry | MultiLineStringGeometry;
  const lines = countryMesh.type === "LineString" ? [countryMesh.coordinates] : countryMesh.coordinates;

  countryBoundaryLineCache = lines.map((line) => line.map(([lng, lat]) => ({ lat, lng })));
  return countryBoundaryLineCache;
}

export function buildCoastParticles() {
  if (coastParticleCache) return coastParticleCache;

  const lines = buildCoastLines();
  const particles: LandParticle[] = [];

  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      const start = line[index];
      const end = line[index + 1];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(end.lng - start.lng), Math.abs(end.lat - start.lat)) / 0.95));
      for (let step = 0; step <= steps; step += 1) {
        const progress = step / steps;
        particles.push({
          lat: start.lat + (end.lat - start.lat) * progress,
          lng: start.lng + (end.lng - start.lng) * progress,
          revealAt: 0,
        });
      }
    }
  }

  coastParticleCache = particles;
  return particles;
}

export function buildCoastLines() {
  if (coastLineCache) return coastLineCache;

  const topology = landTopology as TopologyObject;
  const coastMesh = mesh(topology as never, topoObject(topology, "land") as never) as LineStringGeometry | MultiLineStringGeometry;
  const lines = coastMesh.type === "LineString" ? [coastMesh.coordinates] : coastMesh.coordinates;
  coastLineCache = lines.map((line) => line.map(([lng, lat]) => ({ lat, lng })));
  return coastLineCache;
}
