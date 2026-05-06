import { geoContains } from "d3-geo";
import { feature, mesh } from "topojson-client";
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

let landParticleCache: LandParticle[] | undefined;
let coastParticleCache: LandParticle[] | undefined;

function hash(seed: number) {
  return Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
}

function topoObject(topology: TopologyObject, key: string) {
  const object = topology.objects[key];
  if (!object) throw new Error(`Missing TopoJSON object: ${key}`);
  return object;
}

export function buildLandParticles() {
  if (landParticleCache) return landParticleCache;

  const topology = landTopology as TopologyObject;
  const land = feature(topology as never, topoObject(topology, "land") as never) as unknown as Parameters<typeof geoContains>[0];
  const particles: LandParticle[] = [];

  for (let lat = -58; lat <= 83; lat += 0.9) {
    const latitudeFactor = Math.max(0.34, Math.cos((lat * Math.PI) / 180));
    const lngStep = 1.12 / latitudeFactor;

    for (let lng = -180; lng <= 180; lng += lngStep) {
      const seed = (lat + 91.7) * 1000 + lng * 7.31;
      const jitterLat = (hash(seed) - 0.5) * 0.34;
      const jitterLng = (hash(seed + 13.37) - 0.5) * lngStep * 0.34;
      const point: [number, number] = [lng + jitterLng, lat + jitterLat];

      if (!geoContains(land, point)) continue;

      particles.push({
        lat: point[1],
        lng: point[0],
        revealAt: 0.08 + hash(seed + 5.9) * 0.52,
      });
    }
  }

  landParticleCache = particles;
  return particles;
}

export function buildCoastParticles() {
  if (coastParticleCache) return coastParticleCache;

  const topology = landTopology as TopologyObject;
  const coastMesh = mesh(topology as never, topoObject(topology, "land") as never) as LineStringGeometry | MultiLineStringGeometry;
  const lines = coastMesh.type === "LineString" ? [coastMesh.coordinates] : coastMesh.coordinates;
  const particles: LandParticle[] = [];

  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      const [startLng, startLat] = line[index];
      const [endLng, endLat] = line[index + 1];
      if (Math.abs(endLng - startLng) > 180) continue;

      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(endLng - startLng), Math.abs(endLat - startLat)) / 0.95));
      for (let step = 0; step <= steps; step += 1) {
        const progress = step / steps;
        particles.push({
          lat: startLat + (endLat - startLat) * progress,
          lng: startLng + (endLng - startLng) * progress,
          revealAt: 0,
        });
      }
    }
  }

  coastParticleCache = particles;
  return particles;
}
