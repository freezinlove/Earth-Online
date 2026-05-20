import { safeArray } from "./arrays.mjs";
import { buildRoute } from "./route-projector.mjs";
import { rebuildTrips, rebuildTripsForPhotos } from "./trip-rebuilder.mjs";
import { applyPendingDecision } from "./pending-workflow.mjs";
import {
  acceptRelatedMissingPendingItems,
  applyManualPlaceAssignment,
  archivePhotoUnlocated,
  manualLocationCandidate,
  manualPlaceNames,
} from "./manual-place-core.mjs";

function basename(value) {
  return String(value ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function nowIso() {
  return new Date().toISOString();
}

function cleanTags(tags) {
  return tags.map(String).map((tag) => tag.trim()).filter(Boolean);
}

function manualPlace({ id, tripId, name, point, geo, photoIds = [], timeRange, now, coordinatePrecision }) {
  return {
    id,
    tripId,
    name,
    names: manualPlaceNames(name),
    displayName: name,
    userEdits: { name, updatedAt: now },
    center: point,
    ...geo,
    ...(coordinatePrecision ? { coordinatePrecision } : {}),
    photoIds,
    timeRange,
    pending: false,
  };
}

export function createTripState(state, body, { makeId }) {
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
  return { ...state, trips: [...state.trips, trip] };
}

export function patchTripState(state, id, body) {
  return {
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
  };
}

export function deleteTripState(state, id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return { state, removedTrip: undefined, removedPhotos: [], removedPhotoIds: [], pendingIds: [] };
  const removedPhotos = state.photos.filter((photo) => photo.tripId === id);
  const photoIds = new Set(removedPhotos.map((photo) => photo.id));
  const pendingIds = new Set(
    state.pendingItems
      .filter((item) => item.relatedTripId === id || safeArray(item.relatedPhotoIds).some((photoId) => photoIds.has(photoId)))
      .map((item) => item.id),
  );

  return {
    state: {
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
        storedFileNames: safeArray(batch.storedFileNames).filter((name) => !removedPhotos.some((photo) => basename(photo.storageUrl) === basename(name))),
        storedThumbnailNames: safeArray(batch.storedThumbnailNames).filter((name) => !removedPhotos.some((photo) => basename(photo.thumbnailUrl) === basename(name))),
      })),
    },
    removedTrip: trip,
    removedPhotos,
    removedPhotoIds: Array.from(photoIds),
    pendingIds: Array.from(pendingIds),
  };
}

export function createPlaceState(state, body, { makeId, now = nowIso(), geo }) {
  const center = { lat: Number(body.lat), lng: Number(body.lng) };
  const name = body.name?.trim() || "手动地点";
  const place = manualPlace({
    id: makeId("manual-place"),
    tripId: body.tripId,
    name,
    point: center,
    geo,
    photoIds: [],
    timeRange: { start: now, end: now },
    now,
  });
  const placeNodes = [...state.placeNodes, place];
  const tripPlaces = placeNodes.filter((item) => item.tripId === body.tripId);
  const routes = state.routes.filter((route) => route.tripId !== body.tripId).concat(buildRoute(body.tripId, tripPlaces));
  return { ...state, placeNodes, routes };
}

export function patchPlaceState(state, placeId, body, { now = nowIso() } = {}) {
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("请输入地点名。");
  const place = state.placeNodes.find((item) => item.id === placeId);
  if (!place) return state;
  return {
    ...state,
    placeNodes: state.placeNodes.map((item) =>
      item.id === placeId
        ? {
            ...item,
            name,
            names: manualPlaceNames(name),
            displayName: name,
            userEdits: { ...(item.userEdits ?? {}), name, updatedAt: now },
          }
        : item,
    ),
  };
}

export function deletePlaceState(state, placeId) {
  const place = state.placeNodes.find((item) => item.id === placeId);
  if (!place) return state;
  const placeNodes = state.placeNodes.filter((item) => item.id !== placeId);
  const tripPlaces = placeNodes.filter((item) => item.tripId === place.tripId);
  const routes = state.routes.filter((route) => route.tripId !== place.tripId).concat(buildRoute(place.tripId, tripPlaces));
  return {
    ...state,
    photos: state.photos.map((photo) => (photo.placeNodeId === placeId ? { ...photo, placeNodeId: undefined } : photo)),
    placeNodes,
    routes,
  };
}

export function reorderPlacesState(state, tripId, body) {
  const order = Array.isArray(body) ? body : safeArray(body.placeIds);
  const owned = state.placeNodes.filter((place) => place.tripId === tripId);
  const byId = new Map(owned.map((place) => [place.id, place]));
  const orderedOwned = order.map((id) => byId.get(id)).filter(Boolean);
  for (const place of owned) {
    if (!orderedOwned.some((item) => item.id === place.id)) orderedOwned.push(place);
  }
  const other = state.placeNodes.filter((place) => place.tripId !== tripId);
  const placeNodes = [...other, ...orderedOwned];
  const routes = state.routes.filter((route) => route.tripId !== tripId).concat(buildRoute(tripId, orderedOwned));
  return { ...state, placeNodes, routes };
}

export function movePhotoState(state, photoId, body, { makeId }) {
  const beforeTripId = state.photos.find((photo) => photo.id === photoId)?.tripId;
  const patched = {
    ...state,
    photos: state.photos.map((photo) => (photo.id === photoId ? { ...photo, tripId: body.tripId, placeNodeId: undefined } : photo)),
    placeNodes: state.placeNodes.map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => id !== photoId) })),
  };
  return rebuildTrips(patched, new Set([beforeTripId, body.tripId].filter(Boolean)), { makeId });
}

export function deletePhotoState(state, photoId, { makeId }) {
  const removedPhotos = state.photos.filter((photo) => photo.id === photoId);
  const photo = removedPhotos[0];
  if (!photo) return { state, removedPhotos: [], removedPhotoIds: [] };
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
  return {
    state: rebuildTrips(patched, affectedTripIds, { makeId }),
    removedPhotos,
    removedPhotoIds: [photoId],
  };
}

export function patchPhotoState(state, photoId, body, { makeId, now = nowIso() }) {
  const lat = body.location?.lat === "" || body.location?.lat === undefined ? undefined : Number(body.location.lat);
  const lng = body.location?.lng === "" || body.location?.lng === undefined ? undefined : Number(body.location.lng);
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
  const userEdits =
    body.userEdits && typeof body.userEdits === "object"
      ? {
          title: typeof body.userEdits.title === "string" ? body.userEdits.title.trim() : undefined,
          caption: typeof body.userEdits.caption === "string" ? body.userEdits.caption.trim() : undefined,
          tags: Array.isArray(body.userEdits.tags) ? cleanTags(body.userEdits.tags) : undefined,
          updatedAt: now,
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
  return rebuildTripsForPhotos(patched, new Set([photoId]), { makeId });
}

export function bindPhotoState(state, photoId, placeId, { makeId, now = nowIso() }) {
  const place = state.placeNodes.find((item) => item.id === placeId);
  const beforeTripId = state.photos.find((photo) => photo.id === photoId)?.tripId;
  if (!place) return state;
  const patched = {
    ...state,
    photos: state.photos.map((photo) =>
      photo.id === photoId
        ? applyManualPlaceAssignment(photo, place, {
            now,
            source: "manual_existing_place",
            reason: "用户手动将照片移动到已有地点。",
          })
        : photo,
    ),
    placeNodes: state.placeNodes.map((item) => ({
      ...item,
      photoIds: item.id === place.id ? Array.from(new Set([...item.photoIds, photoId])) : item.photoIds.filter((id) => id !== photoId),
      pending: item.id === place.id ? false : item.pending,
    })),
  };
  return rebuildTrips(patched, new Set([beforeTripId, place.tripId].filter(Boolean)), { makeId });
}

export function createPlaceForPhotoState(state, photoId, body, { makeId, now = nowIso(), geo }) {
  const photo = state.photos.find((item) => item.id === photoId);
  if (!photo?.tripId) return state;
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("请输入地点名。");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("请输入有效经纬度。");
  const point = { lat, lng };
  const place = manualPlace({
    id: makeId("manual-place"),
    tripId: photo.tripId,
    name,
    point,
    geo,
    coordinatePrecision: "estimated",
    photoIds: [photo.id],
    timeRange: { start: photo.capturedAt ?? now, end: photo.capturedAt ?? now },
    now,
  });
  const patched = {
    ...state,
    placeNodes: state.placeNodes.map((item) => ({ ...item, photoIds: item.photoIds.filter((id) => id !== photoId) })).concat(place),
    photos: state.photos.map((item) =>
      item.id === photoId
        ? applyManualPlaceAssignment(item, place, {
            now,
            source: "manual_new_place",
            reason: "用户手动新建地点并移动照片。",
            candidate: manualLocationCandidate({ name, point, geo, makeId }),
          })
        : item,
    ),
  };
  return rebuildTrips(patched, new Set([photo.tripId]), { makeId });
}

export function updatePendingState(state, id, body, { makeId, forwardGeocode }) {
  const pending = state.pendingItems.find((item) => item.id === id);
  const applied = applyPendingDecision(state, id, { accepted: Boolean(body.accepted), forwardGeocode });
  return body.accepted ? rebuildTripsForPhotos(applied, new Set(pending?.relatedPhotoIds ?? []), { makeId, allowExistingPlaceMerge: true }) : applied;
}

export async function resolvePendingManuallyState(state, id, body = {}, { makeId, now = nowIso(), geoForPoint }) {
  const pending = state.pendingItems.find((item) => item.id === id);
  if (!pending || !["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"].includes(pending.type)) return state;
  const photoIds = pending.relatedPhotoIds ?? [];
  if (!photoIds.length) return state;
  const photos = state.photos.filter((photo) => photoIds.includes(photo.id));
  const primaryPhoto = photos[0];
  const tripId = pending.relatedTripId ?? primaryPhoto?.tripId;
  if (!primaryPhoto || !tripId) return state;

  if (body.action === "bind_existing_place") {
    const place = state.placeNodes.find((item) => item.id === body.placeId);
    if (!place) throw new Error("请选择一个已有地点。");
    const patched = {
      ...state,
      photos: state.photos.map((photo) =>
        photoIds.includes(photo.id)
          ? applyManualPlaceAssignment(photo, place, {
              now,
              source: "manual_existing_place",
              reason: "用户手动合并到已有地点。",
            })
          : photo,
      ),
      pendingItems: acceptRelatedMissingPendingItems(state.pendingItems, pending, photoIds),
    };
    return rebuildTrips(patched, new Set([tripId, place.tripId].filter(Boolean)), { makeId });
  }

  if (body.action === "create_manual_place") {
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const name = String(body.name ?? "").trim();
    if (!name) throw new Error("请输入地点名。");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("请输入有效经纬度。");
    const point = { lat, lng };
    const geo = await geoForPoint(point);
    const placeId = makeId("manual-place");
    const dates = photos.map((photo) => photo.capturedAt).filter(Boolean).sort();
    const place = manualPlace({
      id: placeId,
      tripId,
      name,
      point,
      geo,
      coordinatePrecision: "estimated",
      photoIds,
      timeRange: { start: dates[0] ?? now, end: dates.at(-1) ?? dates[0] ?? now },
      now,
    });
    const patched = {
      ...state,
      placeNodes: [...state.placeNodes, place],
      photos: state.photos.map((photo) =>
        photoIds.includes(photo.id)
          ? applyManualPlaceAssignment(photo, place, {
              now,
              source: "manual_new_place",
              reason: "用户手动新建地点。",
              precision: "estimated",
              candidate: manualLocationCandidate({ name, point, geo, makeId }),
            })
          : photo,
      ),
      pendingItems: acceptRelatedMissingPendingItems(state.pendingItems, pending, photoIds),
    };
    return rebuildTrips(patched, new Set([tripId]), { makeId });
  }

  if (body.action === "archive_unlocated") {
    const patched = {
      ...state,
      photos: state.photos.map((photo) => (photoIds.includes(photo.id) ? archivePhotoUnlocated(photo, { now }) : photo)),
      pendingItems: acceptRelatedMissingPendingItems(state.pendingItems, pending, photoIds),
    };
    return rebuildTripsForPhotos(patched, new Set(photoIds), { makeId });
  }

  throw new Error("未知的手动处理方式。");
}
