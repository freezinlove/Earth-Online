import type { PlaceNode } from "@/domain/models";

export function placeFocusIntent(place: Pick<PlaceNode, "center">) {
  return {
    source: "timeline-place" as const,
    point: place.center,
    distance: "near" as const,
  };
}
