import { buildDossierGroups } from "./dossier-projector.mjs";
import { buildGlobeMarkers } from "./globe-projector.mjs";
import { buildSearchDocuments } from "./search-projector.mjs";
import { normalizeState } from "./state-normalizer.mjs";
import { buildTimelineSegments } from "./timeline-projector.mjs";

export function projectState(state) {
  const normalized = normalizeState(state);
  return {
    ...normalized,
    timelineSegments: buildTimelineSegments(normalized.trips, normalized.placeNodes),
    globeMarkers: buildGlobeMarkers(normalized),
    dossierGroups: buildDossierGroups(normalized),
    searchDocuments: buildSearchDocuments(normalized),
  };
}
