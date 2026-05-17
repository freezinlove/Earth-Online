import { normalizeState as normalizeSharedState } from "../../shared/domain/state-normalizer.mjs";
import { reverseLocalGeocode } from "./local-geocoder.mjs";

export function normalizeState(state) {
  return normalizeSharedState(state, { reverseGeocode: reverseLocalGeocode });
}
