import { buildCoastParticles, buildLandParticles } from "@/features/earth/worldData";
import type { GeoPoint } from "@/domain/models";

const workerScope = self as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<ParticleRequest>) => void) => void;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};

type ParticleLayerKind = "land" | "coast";

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

workerScope.addEventListener("message", (event: MessageEvent<ParticleRequest>) => {
  const { kind, radius } = event.data;
  const particles = kind === "land" ? buildLandParticles() : buildCoastParticles();
  const positions = new Float32Array(particles.length * 3);

  particles.forEach((particle, index) => {
    const altitude = kind === "land" ? 0.01 + particle.revealAt * 0.006 : 0.018;
    positions.set(vectorFromGeoPoint(particle, radius, altitude), index * 3);
  });

  workerScope.postMessage({ kind, positions }, [positions.buffer]);
});
