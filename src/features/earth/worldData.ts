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

export type BoundarySegment = {
  start: GeoPoint;
  end: GeoPoint;
};

function hash(seed: number) {
  return Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
}

function topoObject(topology: TopologyObject, key: string) {
  const object = topology.objects[key];
  if (!object) throw new Error(`Missing TopoJSON object: ${key}`);
  return object;
}

export function buildLandParticles() {
  const topology = landTopology as TopologyObject;
  const land = feature(topology as never, topoObject(topology, "land") as never) as unknown as Parameters<typeof geoContains>[0];
  const particles: LandParticle[] = [];

  for (let lat = -58; lat <= 83; lat += 0.95) {
    const latitudeFactor = Math.max(0.34, Math.cos((lat * Math.PI) / 180));
    const lngStep = 1.22 / latitudeFactor;

    for (let lng = -180; lng <= 180; lng += lngStep) {
      const seed = (lat + 91.7) * 1000 + lng * 7.31;
      const jitterLat = (hash(seed) - 0.5) * 0.46;
      const jitterLng = (hash(seed + 13.37) - 0.5) * lngStep * 0.46;
      const point: [number, number] = [lng + jitterLng, lat + jitterLat];

      if (!geoContains(land, point)) continue;

      particles.push({
        lat: point[1],
        lng: point[0],
        revealAt: 0.08 + hash(seed + 5.9) * 0.52,
      });
    }
  }

  return particles;
}

export function buildCountryBoundarySegments() {
  const topology = countriesTopology as TopologyObject;
  const countryMesh = mesh(topology as never, topoObject(topology, "countries") as never, (left, right) => left !== right) as LineStringGeometry | MultiLineStringGeometry;
  const lines = countryMesh.type === "LineString" ? [countryMesh.coordinates] : countryMesh.coordinates;
  const segments: BoundarySegment[] = [];

  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      const [startLng, startLat] = line[index];
      const [endLng, endLat] = line[index + 1];
      segments.push({
        start: { lat: startLat, lng: startLng },
        end: { lat: endLat, lng: endLng },
      });
    }
  }

  return segments;
}
