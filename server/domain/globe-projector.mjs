import { buildGlobeMarkers as buildSharedGlobeMarkers } from "../../shared/domain/projectors.mjs";
import { countryCapitalPoint } from "./local-geocoder.mjs";

export function buildGlobeMarkers(state) {
  return buildSharedGlobeMarkers(state, { countryCapitalPoint });
}
