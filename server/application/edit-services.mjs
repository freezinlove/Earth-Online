import fs from "node:fs/promises";
import path from "node:path";
import { normalizeCountryDescription } from "../domain/country-normalizer.mjs";
import { forwardLocalGeocode, reverseLocalGeocode } from "../domain/local-geocoder.mjs";
import { rebuildTripsForPhotos } from "../domain/trip-rebuilder.mjs";
import {
  bindPhotoState,
  createPlaceForPhotoState,
  createPlaceState,
  createTripState,
  deletePhotoState,
  deletePlaceState,
  deleteTripState,
  movePhotoState,
  patchPhotoState,
  patchPlaceState,
  patchTripState,
  reorderPlacesState,
  resolvePendingManuallyState,
  updatePendingState,
} from "../../shared/domain/edit-state-core.mjs";

export function createEditServices({ readState, readVectorIndex, writeState, writeVectorIndex, responseState, makeId, paths }) {
  async function createTrip(body) {
    const state = await readState();
    await writeState(createTripState(state, body, { makeId }));
    return responseState();
  }

  async function patchTrip(id, body) {
    const state = await readState();
    await writeState(patchTripState(state, id, body));
    return responseState();
  }

  async function deleteTrip(id) {
    const state = await readState();
    const result = deleteTripState(state, id);
    if (!result.removedTrip) return responseState();

    for (const photo of result.removedPhotos) {
      if (photo.storageUrl) await fs.rm(path.join(paths.photoDir, path.basename(photo.storageUrl)), { force: true });
      if (photo.thumbnailUrl) await fs.rm(path.join(paths.thumbDir, path.basename(photo.thumbnailUrl)), { force: true });
    }

    if (result.removedPhotoIds.length) {
      const vectorIndex = await readVectorIndex();
      for (const photoId of result.removedPhotoIds) delete vectorIndex[photoId];
      await writeVectorIndex(vectorIndex);
    }
    await writeState(result.state);
    return responseState();
  }

  async function createPlace(body) {
    const state = await readState();
    const now = new Date().toISOString();
    const center = { lat: Number(body.lat), lng: Number(body.lng) };
    const geo = manualGeoDescription(center);
    await writeState(createPlaceState(state, body, { makeId, now, geo }));
    return responseState();
  }

  async function patchPlace(placeId, body) {
    const state = await readState();
    const now = new Date().toISOString();
    await writeState(patchPlaceState(state, placeId, body, { now }));
    return responseState();
  }

  async function deletePlace(placeId) {
    const state = await readState();
    await writeState(deletePlaceState(state, placeId));
    return responseState();
  }

  async function reorderPlaces(tripId, body) {
    const state = await readState();
    await writeState(reorderPlacesState(state, tripId, body));
    return responseState();
  }

  async function movePhoto(photoId, body) {
    const state = await readState();
    await writeState(movePhotoState(state, photoId, body, { makeId }));
    return responseState();
  }

  async function deletePhoto(photoId) {
    const state = await readState();
    const result = deletePhotoState(state, photoId, { makeId });
    const photo = result.removedPhotos[0];
    if (!photo) return responseState();

    if (photo.storageUrl) await fs.rm(path.join(paths.photoDir, path.basename(photo.storageUrl)), { force: true });
    if (photo.thumbnailUrl) await fs.rm(path.join(paths.thumbDir, path.basename(photo.thumbnailUrl)), { force: true });

    const vectorIndex = await readVectorIndex();
    for (const removedPhotoId of result.removedPhotoIds) delete vectorIndex[removedPhotoId];
    await writeVectorIndex(vectorIndex);
    await writeState(result.state);
    return responseState();
  }

  async function patchPhoto(photoId, body) {
    const state = await readState();
    await writeState(patchPhotoState(state, photoId, body, { makeId, now: new Date().toISOString() }));
    return responseState();
  }

  async function bindPhoto(photoId, body) {
    const state = await readState();
    await writeState(bindPhotoState(state, photoId, body.placeId, { makeId, now: new Date().toISOString() }));
    return responseState();
  }

  async function createPlaceForPhoto(photoId, body) {
    const state = await readState();
    const photo = state.photos.find((item) => item.id === photoId);
    if (!photo?.tripId) return responseState();
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const name = String(body.name ?? "").trim();
    if (!name) throw new Error("请输入地点名。");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("请输入有效经纬度。");
    const point = { lat, lng };
    const geo = manualGeoDescription(point);
    await writeState(createPlaceForPhotoState(state, photoId, body, { makeId, now: new Date().toISOString(), geo }));
    return responseState();
  }

  async function updatePending(id, body) {
    const state = await readState();
    await writeState(updatePendingState(state, id, body, { makeId, forwardGeocode: forwardLocalGeocode }));
    return responseState();
  }

  async function resolvePendingManually(id, body = {}) {
    const state = await readState();
    const next = await resolvePendingManuallyState(state, id, body, { makeId, now: new Date().toISOString(), geoForPoint: manualGeoDescription });
    await writeState(next);
    return responseState();
  }

  function manualGeoDescription(point) {
    const candidate = reverseLocalGeocode(point, { makeId, preferCity: true })[0];
    const country = normalizeCountryDescription(candidate?.country, candidate?.localizedCountryNames);
    return {
      country: country.country,
      countryNames: country.countryNames,
      city: candidate?.city,
      cityNames: candidate?.localizedCityNames,
    };
  }

  async function confirmPhotoLocation(photoId, body = {}) {
    const state = await readState();
    const photo = state.photos.find((item) => item.id === photoId);
    if (!photo) return responseState();
    const candidates = photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [];
    const candidate = candidates.find((item) => item.id === body.candidateId) ?? candidates.find((item) => item.id === photo.locationResolution?.candidateId) ?? candidates[0];
    if (!candidate?.point) throw new Error("没有可确认的地点候选。");
    const patched = {
      ...state,
      photos: state.photos.map((item) =>
        item.id === photoId
          ? {
              ...item,
              location: candidate.point,
              pendingReason: undefined,
              locationResolution: {
                ...(item.locationResolution ?? {}),
                status: "confirmed",
                effectiveName: candidate.name,
                effectivePoint: candidate.point,
                confidence: candidate.confidence,
                source: candidate.source ?? "ai_vision",
                candidateId: candidate.id,
                candidates,
                requiresUserAction: false,
                updatedAt: new Date().toISOString(),
              },
            }
          : item,
      ),
      pendingItems: state.pendingItems.map((item) =>
        item.relatedPhotoIds?.includes(photoId) && item.type === "confirm_location_candidate" ? { ...item, status: "accepted" } : item,
      ),
    };
    await writeState(rebuildTripsForPhotos(patched, new Set([photoId]), { makeId }));
    return responseState();
  }

  async function rejectPhotoLocation(photoId, body = {}) {
    const state = await readState();
    const patched = {
      ...state,
      photos: state.photos.map((photo) => {
        if (photo.id !== photoId) return photo;
        const candidates = photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [];
        return {
          ...photo,
          locationResolution: {
            ...(photo.locationResolution ?? {}),
            status: "rejected",
            rejectedCandidateId: body.candidateId ?? photo.locationResolution?.candidateId,
            candidates,
            requiresUserAction: false,
            updatedAt: new Date().toISOString(),
          },
        };
      }),
      pendingItems: state.pendingItems.map((item) =>
        item.relatedPhotoIds?.includes(photoId) && item.type === "confirm_location_candidate" ? { ...item, status: "ignored" } : item,
      ),
    };
    await writeState(patched);
    return responseState();
  }

  async function tripProjection(tripId) {
    const snapshot = await responseState();
    return {
      trip: snapshot.trips.find((trip) => trip.id === tripId),
      photos: snapshot.photos.filter((photo) => photo.tripId === tripId),
      placeNodes: snapshot.placeNodes.filter((place) => place.tripId === tripId),
      routes: snapshot.routes.filter((route) => route.tripId === tripId),
      timelineSegments: snapshot.timelineSegments.filter((segment) => segment.relatedId === tripId || snapshot.placeNodes.some((place) => place.tripId === tripId && place.id === segment.relatedId)),
      globeMarkers: snapshot.globeMarkers.filter((marker) => marker.tripId === tripId),
      dossierGroup: snapshot.dossierGroups.find((group) => group.tripId === tripId),
      pendingItems: snapshot.pendingItems.filter((item) => item.relatedTripId === tripId),
    };
  }

  return {
    createTrip,
    patchTrip,
    deleteTrip,
    createPlace,
    patchPlace,
    deletePlace,
    reorderPlaces,
    movePhoto,
    deletePhoto,
    patchPhoto,
    bindPhoto,
    createPlaceForPhoto,
    updatePending,
    resolvePendingManually,
    confirmPhotoLocation,
    rejectPhotoLocation,
    tripProjection,
  };
}
