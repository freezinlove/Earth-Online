import fs from "node:fs/promises";
import path from "node:path";
import { safeArray } from "../domain/arrays.mjs";
import { normalizeCountryDescription } from "../domain/country-normalizer.mjs";
import { reverseLocalGeocode } from "../domain/local-geocoder.mjs";
import { applyPendingDecision } from "../domain/pending-workflow.mjs";
import { buildRoute } from "../domain/route-projector.mjs";
import { rebuildTrips, rebuildTripsForPhotos } from "../domain/trip-rebuilder.mjs";

export function createEditServices({ readState, readVectorIndex, writeState, writeVectorIndex, responseState, makeId, paths }) {
  async function createTrip(body) {
    const state = await readState();
    const trip = {
      id: makeId("manual-trip"),
      title: body.title?.trim() || "未命名旅行档案",
      dateRange: { start: body.start, end: body.end },
      countries: ["待确认"],
      cities: ["手动标记"],
      coverUrl: "https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=1200&q=82",
      photoCount: 0,
      placeNodeCount: 0,
      status: "draft",
      source: "manual",
    };
    await writeState({ ...state, trips: [...state.trips, trip] });
    return responseState();
  }

  async function patchTrip(id, body) {
    const state = await readState();
    await writeState({
      ...state,
      trips: state.trips.map((trip) =>
        trip.id === id
          ? {
              ...trip,
              title: body.title?.trim() || trip.title,
              dateRange: body.dateRange ?? trip.dateRange,
            }
          : trip,
      ),
    });
    return responseState();
  }

  async function deleteTrip(id) {
    const state = await readState();
    const trip = state.trips.find((item) => item.id === id);
    if (!trip) return responseState();
    const tripPhotos = state.photos.filter((photo) => photo.tripId === id);
    const photoIds = new Set(tripPhotos.map((photo) => photo.id));
    const pendingIds = new Set(
      state.pendingItems
        .filter((item) => item.relatedTripId === id || safeArray(item.relatedPhotoIds).some((photoId) => photoIds.has(photoId)))
        .map((item) => item.id),
    );

    for (const photo of tripPhotos) {
      if (photo.storageUrl) await fs.rm(path.join(paths.photoDir, path.basename(photo.storageUrl)), { force: true });
      if (photo.thumbnailUrl) await fs.rm(path.join(paths.thumbDir, path.basename(photo.thumbnailUrl)), { force: true });
    }

    const vectorIndex = await readVectorIndex();
    for (const photoId of photoIds) delete vectorIndex[photoId];
    await writeVectorIndex(vectorIndex);

    await writeState({
      ...state,
      trips: state.trips.filter((item) => item.id !== id),
      photos: state.photos.filter((photo) => photo.tripId !== id),
      placeNodes: state.placeNodes.filter((place) => place.tripId !== id),
      routes: state.routes.filter((route) => route.tripId !== id),
      pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
      importBatches: state.importBatches.map((batch) => ({
        ...batch,
        addedPhotoIds: safeArray(batch.addedPhotoIds).filter((photoId) => !photoIds.has(photoId)),
        duplicatePhotoIds: safeArray(batch.duplicatePhotoIds).filter((photoId) => !photoIds.has(photoId)),
        createdTripIds: safeArray(batch.createdTripIds).filter((tripId) => tripId !== id),
        updatedTripIds: safeArray(batch.updatedTripIds).filter((tripId) => tripId !== id),
        pendingItemIds: safeArray(batch.pendingItemIds).filter((pendingId) => !pendingIds.has(pendingId)),
        storedFileNames: safeArray(batch.storedFileNames).filter((name) => !tripPhotos.some((photo) => path.basename(photo.storageUrl ?? "") === path.basename(name))),
        storedThumbnailNames: safeArray(batch.storedThumbnailNames).filter((name) => !tripPhotos.some((photo) => path.basename(photo.thumbnailUrl ?? "") === path.basename(name))),
      })),
    });
    return responseState();
  }

  async function createPlace(body) {
    const state = await readState();
    const now = new Date().toISOString();
    const center = { lat: Number(body.lat), lng: Number(body.lng) };
    const geo = manualGeoDescription(center);
    const place = {
      id: makeId("manual-place"),
      tripId: body.tripId,
      name: body.name?.trim() || "手动地点",
      center,
      ...geo,
      photoIds: [],
      timeRange: { start: now, end: now },
      pending: false,
    };
    const placeNodes = [...state.placeNodes, place];
    const tripPlaces = placeNodes.filter((item) => item.tripId === body.tripId);
    const routes = state.routes.filter((route) => route.tripId !== body.tripId).concat(buildRoute(body.tripId, tripPlaces));
    await writeState({ ...state, placeNodes, routes });
    return responseState();
  }

  async function deletePlace(placeId) {
    const state = await readState();
    const place = state.placeNodes.find((item) => item.id === placeId);
    if (!place) return responseState();
    const placeNodes = state.placeNodes.filter((item) => item.id !== placeId);
    const tripPlaces = placeNodes.filter((item) => item.tripId === place.tripId);
    const routes = state.routes.filter((route) => route.tripId !== place.tripId).concat(buildRoute(place.tripId, tripPlaces));
    await writeState({
      ...state,
      photos: state.photos.map((photo) => (photo.placeNodeId === placeId ? { ...photo, placeNodeId: undefined } : photo)),
      placeNodes,
      routes,
    });
    return responseState();
  }

  async function reorderPlaces(tripId, body) {
    const state = await readState();
    const order = safeArray(body.placeIds);
    const owned = state.placeNodes.filter((place) => place.tripId === tripId);
    const byId = new Map(owned.map((place) => [place.id, place]));
    const orderedOwned = order.map((id) => byId.get(id)).filter(Boolean);
    for (const place of owned) {
      if (!orderedOwned.some((item) => item.id === place.id)) orderedOwned.push(place);
    }
    const other = state.placeNodes.filter((place) => place.tripId !== tripId);
    const placeNodes = [...other, ...orderedOwned];
    const routes = state.routes.filter((route) => route.tripId !== tripId).concat(buildRoute(tripId, orderedOwned));
    await writeState({ ...state, placeNodes, routes });
    return responseState();
  }

  async function movePhoto(photoId, body) {
    const state = await readState();
    const beforeTripId = state.photos.find((photo) => photo.id === photoId)?.tripId;
    const patched = {
      ...state,
      photos: state.photos.map((photo) => (photo.id === photoId ? { ...photo, tripId: body.tripId, placeNodeId: undefined } : photo)),
      placeNodes: state.placeNodes.map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => id !== photoId) })),
    };
    await writeState(rebuildTrips(patched, new Set([beforeTripId, body.tripId].filter(Boolean)), { makeId }));
    return responseState();
  }

  async function deletePhoto(photoId) {
    const state = await readState();
    const photo = state.photos.find((item) => item.id === photoId);
    if (!photo) return responseState();

    if (photo.storageUrl) await fs.rm(path.join(paths.photoDir, path.basename(photo.storageUrl)), { force: true });
    if (photo.thumbnailUrl) await fs.rm(path.join(paths.thumbDir, path.basename(photo.thumbnailUrl)), { force: true });

    const vectorIndex = await readVectorIndex();
    delete vectorIndex[photoId];
    await writeVectorIndex(vectorIndex);

    const affectedTripIds = new Set([photo.tripId].filter(Boolean));
    for (const place of state.placeNodes) {
      if (place.photoIds?.includes(photoId)) affectedTripIds.add(place.tripId);
    }
    const pendingItems = state.pendingItems
      .map((item) => ({ ...item, relatedPhotoIds: safeArray(item.relatedPhotoIds).filter((id) => id !== photoId) }))
      .filter((item) => item.relatedPhotoIds.length > 0);
    const patched = {
      ...state,
      photos: state.photos.filter((item) => item.id !== photoId),
      placeNodes: state.placeNodes.map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => id !== photoId) })),
      pendingItems,
      importBatches: state.importBatches.map((batch) => ({
        ...batch,
        addedPhotoIds: safeArray(batch.addedPhotoIds).filter((id) => id !== photoId),
        duplicatePhotoIds: safeArray(batch.duplicatePhotoIds).filter((id) => id !== photoId),
      })),
    };
    await writeState(rebuildTrips(patched, affectedTripIds, { makeId }));
    return responseState();
  }

  async function patchPhoto(photoId, body) {
    const state = await readState();
    const lat = body.location?.lat === "" || body.location?.lat === undefined ? undefined : Number(body.location.lat);
    const lng = body.location?.lng === "" || body.location?.lng === undefined ? undefined : Number(body.location.lng);
    const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
    const userEdits =
      body.userEdits && typeof body.userEdits === "object"
        ? {
            title: typeof body.userEdits.title === "string" ? body.userEdits.title.trim() : undefined,
            caption: typeof body.userEdits.caption === "string" ? body.userEdits.caption.trim() : undefined,
            tags: Array.isArray(body.userEdits.tags) ? body.userEdits.tags.map(String).map((tag) => tag.trim()).filter(Boolean) : undefined,
            updatedAt: new Date().toISOString(),
          }
        : undefined;
    const patched = {
      ...state,
      photos: state.photos.map((photo) =>
        photo.id === photoId
          ? {
              ...photo,
              capturedAt: body.capturedAt === "" ? undefined : body.capturedAt ?? photo.capturedAt,
              location: body.location === undefined ? photo.location : hasLocation ? { lat, lng } : undefined,
              tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : photo.tags,
              userEdits:
                userEdits === undefined
                  ? photo.userEdits
                  : {
                      ...(photo.userEdits ?? {}),
                      ...userEdits,
                    },
              pendingReason: hasLocation && (body.capturedAt ?? photo.capturedAt) ? undefined : photo.pendingReason,
            }
          : photo,
      ),
    };
    await writeState(rebuildTripsForPhotos(patched, new Set([photoId]), { makeId }));
    return responseState();
  }

  async function bindPhoto(photoId, body) {
    const state = await readState();
    const place = state.placeNodes.find((item) => item.id === body.placeId);
    const beforeTripId = state.photos.find((photo) => photo.id === photoId)?.tripId;
    const patched = {
      ...state,
      photos: state.photos.map((photo) =>
        photo.id === photoId
          ? { ...photo, tripId: place?.tripId ?? photo.tripId, placeNodeId: place?.id, location: place?.center ?? photo.location, pendingReason: undefined }
          : photo,
      ),
      placeNodes: state.placeNodes.map((item) => ({
        ...item,
        photoIds: item.id === body.placeId ? Array.from(new Set([...item.photoIds, photoId])) : item.photoIds.filter((id) => id !== photoId),
        pending: item.id === body.placeId ? false : item.pending,
      })),
    };
    await writeState(rebuildTrips(patched, new Set([beforeTripId, place?.tripId].filter(Boolean)), { makeId }));
    return responseState();
  }

  async function updatePending(id, body) {
    const state = await readState();
    const pending = state.pendingItems.find((item) => item.id === id);
    const applied = applyPendingDecision(state, id, { accepted: Boolean(body.accepted) });
    const rebuilt = body.accepted ? rebuildTripsForPhotos(applied, new Set(pending?.relatedPhotoIds ?? []), { makeId, allowExistingPlaceMerge: true }) : applied;
    await writeState(rebuilt);
    return responseState();
  }

  async function resolvePendingManually(id, body = {}) {
    const state = await readState();
    const pending = state.pendingItems.find((item) => item.id === id);
    if (!pending || !["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"].includes(pending.type)) return responseState();
    const photoIds = pending.relatedPhotoIds ?? [];
    if (!photoIds.length) return responseState();
    const photos = state.photos.filter((photo) => photoIds.includes(photo.id));
    const primaryPhoto = photos[0];
    const tripId = pending.relatedTripId ?? primaryPhoto?.tripId;
    if (!primaryPhoto || !tripId) return responseState();
    const now = new Date().toISOString();
    let patched = state;

    if (body.action === "bind_existing_place") {
      const place = state.placeNodes.find((item) => item.id === body.placeId);
      if (!place) throw new Error("请选择一个已有地点。");
      patched = {
        ...state,
        photos: state.photos.map((photo) =>
          photoIds.includes(photo.id)
            ? {
                ...photo,
                tripId: place.tripId,
                placeNodeId: place.id,
                location: place.center,
                aiFailure: undefined,
                pendingReason: undefined,
                exifStatus: clearManualExifStatus(photo, { gps: "fallback" }),
                locationResolution: {
                  ...(photo.locationResolution ?? {}),
                  status: "confirmed",
                  effectiveName: place.displayName ?? place.name,
                  effectivePoint: place.center,
                  confidence: 1,
                  source: "manual_existing_place",
                  candidates: photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [],
                  requiresUserAction: false,
                  updatedAt: now,
                },
              }
            : photo,
        ),
        pendingItems: acceptRelatedMissingPendingItems(state.pendingItems, pending, photoIds),
      };
      await writeState(rebuildTrips(patched, new Set([tripId, place.tripId].filter(Boolean)), { makeId }));
      return responseState();
    }

    if (body.action === "create_manual_place") {
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      const name = String(body.name ?? "").trim();
      if (!name) throw new Error("请输入地点名。");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("请输入有效经纬度。");
      const point = { lat, lng };
      const geo = manualGeoDescription(point);
      const placeId = makeId("manual-place");
      const dates = photos.map((photo) => photo.capturedAt).filter(Boolean).sort();
      const place = {
        id: placeId,
        tripId,
        name,
        displayName: name,
        center: point,
        ...geo,
        coordinatePrecision: "estimated",
        photoIds,
        timeRange: { start: dates[0] ?? now, end: dates.at(-1) ?? dates[0] ?? now },
        pending: false,
      };
      patched = {
        ...state,
        placeNodes: [...state.placeNodes, place],
        photos: state.photos.map((photo) =>
          photoIds.includes(photo.id)
            ? {
                ...photo,
                tripId,
                placeNodeId: placeId,
                location: point,
                aiFailure: undefined,
                pendingReason: undefined,
                exifStatus: clearManualExifStatus(photo, { gps: "fallback" }),
                locationResolution: {
                  ...(photo.locationResolution ?? {}),
                  status: "confirmed",
                  effectiveName: name,
                  effectivePoint: point,
                  confidence: 1,
                  source: "manual_new_place",
                  precision: "estimated",
                  candidates: [manualLocationCandidate({ name, point, geo, makeId }), ...(photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])],
                  requiresUserAction: false,
                  updatedAt: now,
                },
              }
            : photo,
        ),
        pendingItems: acceptRelatedMissingPendingItems(state.pendingItems, pending, photoIds),
      };
      await writeState(rebuildTrips(patched, new Set([tripId]), { makeId }));
      return responseState();
    }

    if (body.action === "archive_unlocated") {
      patched = {
        ...state,
        photos: state.photos.map((photo) =>
          photoIds.includes(photo.id)
            ? {
                ...photo,
                placeNodeId: undefined,
                location: undefined,
                aiFailure: undefined,
                pendingReason: undefined,
                exifStatus: clearManualExifStatus(photo, { gps: "missing" }),
                locationResolution: {
                  ...(photo.locationResolution ?? {}),
                  status: "rejected",
                  effectiveName: undefined,
                  effectivePoint: undefined,
                  confidence: undefined,
                  source: "manual_archived_unlocated",
                  candidates: photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [],
                  requiresUserAction: false,
                  updatedAt: now,
                },
              }
            : photo,
        ),
        pendingItems: acceptRelatedMissingPendingItems(state.pendingItems, pending, photoIds),
      };
      await writeState(rebuildTripsForPhotos(patched, new Set(photoIds), { makeId }));
      return responseState();
    }

    throw new Error("未知的手动处理方式。");
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

  function manualLocationCandidate({ name, point, geo, makeId }) {
    return {
      id: makeId("candidate-manual"),
      name,
      localizedNames: { zh: name, en: name, local: name },
      country: geo.country,
      localizedCountryNames: geo.countryNames,
      city: geo.city ?? name,
      localizedCityNames: geo.cityNames,
      point,
      confidence: 1,
      source: "manual",
      precision: "confirmed",
      reason: "用户手动在地球上标记地点，并由本地地名库反查国家/城市。",
    };
  }

  function clearManualExifStatus(photo, overrides = {}) {
    return {
      ...(photo.exifStatus ?? {}),
      time: photo.exifStatus?.time ?? (photo.capturedAt ? "read" : "missing"),
      gps: overrides.gps ?? photo.exifStatus?.gps ?? (photo.location ? "fallback" : "missing"),
    };
  }

  function acceptRelatedMissingPendingItems(pendingItems, pending, photoIds) {
    const relatedPhotoIds = new Set(photoIds);
    return pendingItems.map((item) =>
      item.id === pending.id ||
      (item.status === "open" &&
        ["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"].includes(item.type) &&
        (item.relatedPhotoIds ?? []).some((photoId) => relatedPhotoIds.has(photoId)))
        ? { ...item, status: "accepted" }
        : item,
    );
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
    deletePlace,
    reorderPlaces,
    movePhoto,
    deletePhoto,
    patchPhoto,
    bindPhoto,
    updatePending,
    resolvePendingManually,
    confirmPhotoLocation,
    rejectPhotoLocation,
    tripProjection,
  };
}
