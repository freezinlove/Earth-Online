import type { GeoPoint } from "@/domain/models";

export function latLngToVector3(point: GeoPoint, radius = 2.05): [number, number, number] {
  const phi = (90 - point.lat) * (Math.PI / 180);
  const theta = (point.lng + 180) * (Math.PI / 180);

  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);

  return [x, y, z];
}
