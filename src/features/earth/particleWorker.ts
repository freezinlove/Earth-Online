import { buildCoastLines, buildCoastParticles, buildCountryBoundaryLines, buildCountryBoundaryParticles, buildLandParticles, buildMediumLandParticles } from "@/features/earth/worldData";
import type { GeoPoint } from "@/domain/models";

const workerScope = self as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<ParticleRequest>) => void) => void;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

type ParticleLayerKind = "land" | "mediumLand" | "coast" | "countryBoundary" | "coastLine" | "countryBoundaryLine";

type ParticleRequest = {
  kind: ParticleLayerKind;
  radius: number;
};

function vectorFromGeoPoint(point: GeoPoint, radius: number, altitude = 0) {
  const phi = ((90 - point.lat) * Math.PI) / 180;
  const theta = ((90 - point.lng) * Math.PI) / 180;
  const scaledRadius = radius * (1 + altitude);

  return [
    scaledRadius * Math.sin(phi) * Math.cos(theta),
    scaledRadius * Math.cos(phi),
    scaledRadius * Math.sin(phi) * Math.sin(theta),
  ] as const;
}

function buildLineSegmentPositions(lines: GeoPoint[][], radius: number, altitude: number, detailStep: number) {
  const positions: number[] = [];

  lines.forEach((line) => {
    for (let index = 0; index < line.length - 1; index += 1) {
      const start = line[index];
      const end = line[index + 1];
      if (Math.abs(end.lng - start.lng) > 180) continue;

      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(end.lng - start.lng), Math.abs(end.lat - start.lat)) / detailStep));
      let previous = vectorFromGeoPoint(start, radius, altitude);

      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        const current = vectorFromGeoPoint(
          {
            lat: start.lat + (end.lat - start.lat) * progress,
            lng: start.lng + (end.lng - start.lng) * progress,
          },
          radius,
          altitude,
        );

        positions.push(...previous, ...current);
        previous = current;
      }
    }
  });

  return new Float32Array(positions);
}

workerScope.addEventListener("message", (event: MessageEvent<ParticleRequest>) => {
  const { kind, radius } = event.data;
  if (kind === "coastLine" || kind === "countryBoundaryLine") {
    const positions =
      kind === "coastLine"
        ? buildLineSegmentPositions(buildCoastLines(), radius, 0.019, 0.45)
        : buildLineSegmentPositions(buildCountryBoundaryLines(), radius, 0.027, 0.28);

    workerScope.postMessage({ kind, positions }, [positions.buffer]);
    return;
  }

  const particles =
    kind === "land"
      ? buildLandParticles()
      : kind === "mediumLand"
        ? buildMediumLandParticles()
        : kind === "countryBoundary"
          ? buildCountryBoundaryParticles()
          : buildCoastParticles();
  const positions = new Float32Array(particles.length * 3);

  particles.forEach((particle, index) => {
    const altitude =
      kind === "land"
        ? 0.01 + particle.revealAt * 0.006
        : kind === "mediumLand"
          ? 0.014 + particle.revealAt * 0.006
          : kind === "countryBoundary"
            ? 0.026
            : 0.018;
    positions.set(vectorFromGeoPoint(particle, radius, altitude), index * 3);
  });

  workerScope.postMessage({ kind, positions }, [positions.buffer]);
});
