import { applyPendingDecision as applySharedPendingDecision } from "../../shared/domain/pending-workflow.mjs";
import { forwardLocalGeocode } from "./local-geocoder.mjs";

export function applyPendingDecision(state, id, { accepted } = {}) {
  return applySharedPendingDecision(state, id, { accepted, forwardGeocode: forwardLocalGeocode });
}
