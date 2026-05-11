import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geoBounds, geoContains } from "d3-geo";
import { feature, mesh } from "topojson-client";

const require = createRequire(import.meta.url);
const countriesTopology = require("world-atlas/countries-110m.json");
const landTopology = require("world-atlas/land-110m.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = path.join(repoRoot, "public", "data", "globe");
const globeRadius = 100;
const surfaceAltitude = 0.022;
const provinceLinesUrl =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson";

function hash(seed) {
  return Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
}

function topoObject(topology, key) {
  const object = topology.objects[key];
  if (!object) throw new Error(`Missing TopoJSON object: ${key}`);
  return object;
}

function featureSeed(item, fallback) {
  const rawId = Number(item.id ?? fallback);
  return Number.isFinite(rawId) ? rawId + 1 : fallback + 1;
}

function vectorFromGeoPoint(point, radius = globeRadius, altitude = 0) {
  const phi = ((90 - point.lat) * Math.PI) / 180;
  const theta = ((90 - point.lng) * Math.PI) / 180;
  const scaledRadius = radius * (1 + altitude);

  return [
    scaledRadius * Math.sin(phi) * Math.cos(theta),
    scaledRadius * Math.cos(phi),
    scaledRadius * Math.sin(phi) * Math.sin(theta),
  ];
}

function pushVector(target, point, altitude) {
  target.push(...vectorFromGeoPoint(point, globeRadius, altitude));
}

function longitudeRanges(minLng, maxLng) {
  return minLng <= maxLng ? [[minLng, maxLng]] : [[minLng, 180], [-180, maxLng]];
}

function longitudeSpan(ranges) {
  return ranges.reduce((total, [minLng, maxLng]) => total + maxLng - minLng, 0);
}

function buildPolarLandPositions(country, seed, bounds, { step, altitude, jitterScale, revealLift }) {
  const [[minLng, minLat], [maxLng, maxLat]] = bounds;
  const ranges = longitudeRanges(minLng, maxLng);
  const startLat = Math.max(-89.2, minLat);
  const endLat = Math.min(84.6, maxLat);
  const targetCount = Math.ceil(((endLat - startLat) * longitudeSpan(ranges)) / (step * step) * 0.1);
  const maxAttempts = targetCount * 18;
  const positions = [];

  for (let attempt = 0; attempt < maxAttempts && positions.length / 3 < targetCount; attempt += 1) {
    const range = ranges[Math.floor(hash(seed * 101.3 + attempt * 3.7) * ranges.length)];
    const lng = range[0] + hash(seed * 233.1 + attempt * 11.9) * (range[1] - range[0]);
    const lat = startLat + hash(seed * 377.9 + attempt * 17.3) * (endLat - startLat);
    const pointSeed = seed * 100000 + attempt * 31.73;
    const point = {
      lat: lat + (hash(pointSeed) - 0.5) * step * jitterScale,
      lng: lng + (hash(pointSeed + 13.37) - 0.5) * step * jitterScale,
    };

    if (!geoContains(country, [point.lng, point.lat])) continue;
    pushVector(positions, point, altitude + hash(pointSeed + 5.9) * revealLift);
  }

  return positions;
}

function buildRegionalLandPositions({ step, altitude, jitterScale, revealLift }) {
  const countries = feature(countriesTopology, topoObject(countriesTopology, "countries")).features;
  const positions = [];

  countries.forEach((country, index) => {
    const bounds = geoBounds(country);
    const [[minLng, minLat], [maxLng, maxLat]] = bounds;
    if (!Number.isFinite(minLng) || !Number.isFinite(minLat) || !Number.isFinite(maxLng) || !Number.isFinite(maxLat)) return;

    const seed = featureSeed(country, index);
    if (minLat < -62) {
      positions.push(...buildPolarLandPositions(country, seed, bounds, { step, altitude, jitterScale, revealLift }));
      return;
    }

    const latPhase = (hash(seed * 17.13) - 0.5) * step * 1.8;
    const startLat = Math.max(-89.2, minLat);
    const endLat = Math.min(84.6, maxLat);
    const lngRanges = longitudeRanges(minLng, maxLng);

    for (let lat = Math.floor((startLat + latPhase) / step) * step - latPhase; lat <= endLat; lat += step) {
      const latitudeFactor = Math.max(0.34, Math.cos((lat * Math.PI) / 180));
      const lngStep = (step * 1.24) / latitudeFactor;
      const lngPhase = (hash(seed * 29.71 + Math.floor((lat + 90) * 10)) - 0.5) * lngStep * 1.8;

      lngRanges.forEach(([rangeMinLng, rangeMaxLng]) => {
        for (let lng = Math.floor((rangeMinLng + lngPhase) / lngStep) * lngStep - lngPhase; lng <= rangeMaxLng; lng += lngStep) {
          const pointSeed = seed * 100000 + (lat + 91.7) * 1000 + lng * 7.31;
          const point = {
            lat: lat + (hash(pointSeed) - 0.5) * step * jitterScale,
            lng: lng + (hash(pointSeed + 13.37) - 0.5) * lngStep * jitterScale,
          };

          if (!geoContains(country, [point.lng, point.lat])) continue;
          pushVector(positions, point, altitude + hash(pointSeed + 5.9) * revealLift);
        }
      });
    }
  });

  return new Float32Array(positions);
}

function buildMeshLines(topology, objectKey, filter) {
  const lineMesh = mesh(topology, topoObject(topology, objectKey), filter);
  const lines = lineMesh.type === "LineString" ? [lineMesh.coordinates] : lineMesh.coordinates;
  return lines.map((line) => line.map(([lng, lat]) => ({ lat, lng })));
}

function buildLineSegmentPositions(lines, altitude, detailStep) {
  const positions = [];

  lines.forEach((line) => {
    for (let index = 0; index < line.length - 1; index += 1) {
      const start = line[index];
      const end = line[index + 1];
      if (Math.abs(end.lng - start.lng) > 180) continue;

      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(end.lng - start.lng), Math.abs(end.lat - start.lat)) / detailStep));
      let previous = vectorFromGeoPoint(start, globeRadius, altitude);

      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        const current = vectorFromGeoPoint(
          {
            lat: start.lat + (end.lat - start.lat) * progress,
            lng: start.lng + (end.lng - start.lng) * progress,
          },
          globeRadius,
          altitude,
        );

        positions.push(...previous, ...current);
        previous = current;
      }
    }
  });

  return new Float32Array(positions);
}

function buildGeoJsonLines(geoJson) {
  const lines = [];

  geoJson.features.forEach((item) => {
    const geometry = item.geometry;
    if (!geometry) return;

    if (geometry.type === "LineString") {
      lines.push(geometry.coordinates.map(([lng, lat]) => ({ lat, lng })));
    }

    if (geometry.type === "MultiLineString") {
      geometry.coordinates.forEach((line) => {
        lines.push(line.map(([lng, lat]) => ({ lat, lng })));
      });
    }
  });

  return lines;
}

async function writeFloat32Asset(name, data) {
  const filePath = path.join(outDir, name);
  await writeFile(filePath, Buffer.from(data.buffer));
  console.log(`${name}: ${(data.length / 3).toLocaleString()} vertices, ${(data.byteLength / 1024).toFixed(1)} KB`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json();
}

await mkdir(outDir, { recursive: true });

const farLand = buildRegionalLandPositions({ step: 1.18, altitude: surfaceAltitude, jitterScale: 0.5, revealLift: 0 });
const midLand = buildRegionalLandPositions({ step: 0.52, altitude: surfaceAltitude, jitterScale: 0.56, revealLift: 0 });
const nearLand = buildRegionalLandPositions({ step: 0.28, altitude: surfaceAltitude, jitterScale: 0.58, revealLift: 0 });
const coastLines = buildMeshLines(landTopology, "land");
const countryLines = buildMeshLines(countriesTopology, "countries", (left, right) => left !== right);
const provinceLines = buildGeoJsonLines(await fetchJson(provinceLinesUrl));

await writeFloat32Asset("land-far.bin", farLand);
await writeFloat32Asset("land-mid.bin", midLand);
await writeFloat32Asset("land-near.bin", nearLand);
await writeFloat32Asset("coast-lines.bin", buildLineSegmentPositions(coastLines, surfaceAltitude, 0.42));
await writeFloat32Asset("country-lines.bin", buildLineSegmentPositions(countryLines, surfaceAltitude, 0.26));
await writeFloat32Asset("province-lines.bin", buildLineSegmentPositions(provinceLines, surfaceAltitude, 0.18));
