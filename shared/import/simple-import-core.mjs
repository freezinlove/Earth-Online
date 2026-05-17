import { centerOf, sortByDate } from "../domain/projection-utils.mjs";

export function toDateInput(value, fallback = new Date().toISOString()) {
  return String(value || fallback).slice(0, 10);
}

export function buildPendingItemForPhoto(
  photo,
  {
    makeId,
    type,
    reason,
    suggestion = "需要手动确认",
  },
) {
  if (typeof makeId !== "function") throw new TypeError("buildPendingItemForPhoto requires makeId");
  return {
    id: makeId("pending"),
    type,
    relatedPhotoIds: [photo.id],
    relatedTripId: photo.tripId,
    suggestion,
    reason,
    status: "open",
  };
}

export function buildSimpleImportState(
  current,
  {
    totalCount,
    photos,
    pendingItems = [],
    summary,
    duplicateCount = 0,
    duplicatePhotoIds = [],
    makeId,
    nowIso = () => new Date().toISOString(),
    titlePrefix = "Mobile Import",
    locatedPlaceName = "定位照片",
    unresolvedCountry = "待确认",
  },
) {
  if (typeof makeId !== "function") throw new TypeError("buildSimpleImportState requires makeId");
  const batchId = makeId("batch");
  const importedAt = nowIso();
  const datedPhotos = photos.slice().sort((left, right) => sortByDate(left.capturedAt, right.capturedAt));
  const start = toDateInput(datedPhotos[0]?.capturedAt, importedAt);
  const end = toDateInput(datedPhotos.at(-1)?.capturedAt ?? datedPhotos[0]?.capturedAt, importedAt);
  const tripId = makeId("trip");
  const located = photos.filter((photo) => photo.location);
  const placeId = located.length ? makeId("place") : undefined;
  const center = centerOf(located.map((photo) => photo.location).filter(Boolean));
  const title = `${titlePrefix} ${start}`;

  const importedPhotos = photos.map((photo) => ({
    ...photo,
    tripId,
    placeNodeId: photo.location && placeId ? placeId : photo.placeNodeId,
  }));
  const importedPendingItems = pendingItems.map((pending) => ({
    ...pending,
    relatedTripId: tripId,
  }));

  const trip = {
    id: tripId,
    title,
    dateRange: { start, end },
    countries: [unresolvedCountry],
    cities: [],
    coverUrl: photos[0]?.thumbnailUrl ?? "",
    photoCount: photos.length,
    placeNodeCount: located.length ? 1 : 0,
    status: "pending",
    source: "import",
  };

  const locatedSorted = importedPhotos.filter((photo) => photo.location).sort((left, right) => sortByDate(left.capturedAt, right.capturedAt));
  const placeNodes =
    placeId && center
      ? [
          {
            id: placeId,
            tripId,
            name: locatedPlaceName,
            displayName: locatedPlaceName,
            country: unresolvedCountry,
            center,
            photoIds: locatedSorted.map((photo) => photo.id),
            timeRange: {
              start: locatedSorted[0]?.capturedAt ?? importedAt,
              end: locatedSorted.at(-1)?.capturedAt ?? locatedSorted[0]?.capturedAt ?? importedAt,
            },
            pending: false,
          },
        ]
      : [];
  const routes =
    placeId && locatedSorted.length
      ? [
          {
            id: makeId("route"),
            tripId,
            points: locatedSorted.map((photo) => photo.location).filter(Boolean),
            status: "auto_generated",
          },
        ]
      : [];

  const batch = {
    id: batchId,
    importedAt,
    totalCount,
    successCount: photos.length,
    failedCount: Math.max(0, totalCount - photos.length - duplicateCount),
    duplicateCount,
    duplicatePhotoIds,
    status: "pending_confirmation",
    createdTripIds: [tripId],
    updatedTripIds: [],
    addedPhotoIds: importedPhotos.map((photo) => photo.id),
    pendingItemIds: importedPendingItems.map((item) => item.id),
    storedFileNames: [],
    storedThumbnailNames: [],
    aiStats: {
      qwenCount: 0,
      fallbackCount: photos.length,
      embeddingCount: 0,
      qwenEmbeddingCount: 0,
      deterministicEmbeddingCount: 0,
    },
    summary,
  };

  return {
    trips: [...current.trips, trip],
    photos: [...current.photos, ...importedPhotos],
    placeNodes: [...current.placeNodes, ...placeNodes],
    routes: [...current.routes, ...routes],
    importBatches: [...current.importBatches, batch],
    pendingItems: [...current.pendingItems, ...importedPendingItems],
  };
}
