import { safeArray } from "../domain/arrays.mjs";
import { multiCityCountryLabel } from "../domain/country-normalizer.mjs";
import { toDateInput } from "../domain/dates.mjs";
import { inferPreset, localizedGeoHint, normalizeLocale } from "../domain/geo.mjs";
import { hasAiProcessingFailure, hasMissingImportInfo } from "../domain/photo-status.mjs";
import { buildPlacesForGroup } from "../domain/place-projector.mjs";
import { buildPhotoRoute, buildRoute } from "../domain/route-projector.mjs";
import { rebuildTrips } from "../domain/trip-rebuilder.mjs";
import { dominantPresetsForPhotos, findAdjacentTrip, groupImportedPhotos } from "../domain/trip-resolver.mjs";

const blockingImportPendingTypes = ["missing_gps", "missing_time", "confirm_location_candidate", "ai_processing_failed"];

function latestPendingImportBatch(state) {
  return safeArray(state.importBatches).filter((item) => item.status === "pending_confirmation").at(-1);
}

function importTripTitle({ month, city, groupIndex = 0, groupCount = 1, locale = "zh" }) {
  const suffix = groupCount > 1 ? ` ${groupIndex + 1}` : "";
  if (normalizeLocale(locale) === "en") return `${month} ${localizedGeoHint(city, locale)} trip${suffix}`;
  return `${month} ${city}旅行${suffix}`;
}

function importTripMultiCityLabel(countries = [], locale = "zh") {
  return multiCityCountryLabel(countries, locale);
}

export { hasAiProcessingFailure, hasMissingImportInfo };

export function addLocationPendingItems(imported, pendingItems, { makeId, completeCandidatePoint = (candidate) => candidate } = {}) {
  const suggestedLocations = imported.filter((photo) => !hasAiProcessingFailure(photo) && photo.locationResolution?.status === "suggested" && photo.locationResolution.candidateId);
  for (const photo of suggestedLocations) {
    const candidate = completeCandidatePoint(photo.locationResolution.candidates.find((item) => item.id === photo.locationResolution.candidateId));
    if (!candidate?.point) continue;
    pendingItems.push({
      id: makeId("pending"),
      type: "confirm_location_candidate",
      relatedPhotoIds: [photo.id],
      relatedTripId: photo.tripId,
      suggestion: `AI 建议将「${photo.title ?? photo.fileName}」定位到「${photo.locationResolution.effectiveName}」。`,
      reason: "照片缺少可靠 EXIF GPS，但 AI 给出了可解释的地点候选，需要用户确认后才写入确定坐标。",
      status: "open",
      proposal: {
        action: "create_place_from_candidate",
        tripId: photo.tripId,
        photoIds: [photo.id],
        candidate,
      },
    });
  }
}

export function addMissingInfoPendingItems(imported, pendingItems, { makeId } = {}) {
  for (const photo of imported.filter((item) => hasMissingImportInfo(item) && !hasAiProcessingFailure(item))) {
    const missingGps = photo.exifStatus?.gps === "missing" || photo.pendingReason === "missing_gps";
    const missingTime = photo.exifStatus?.time !== "read";
    pendingItems.push({
      id: makeId("pending"),
      type: missingGps ? "missing_gps" : "missing_time",
      relatedPhotoIds: [photo.id],
      relatedTripId: photo.tripId,
      suggestion: `${photo.title ?? photo.fileName} 缺少${missingGps && missingTime ? " GPS 和 EXIF 时间" : missingGps ? " GPS" : " EXIF 时间"}，可手动触发基于上下文推断。`,
      reason: "初次导入只完成单张照片理解；需要用户在待补信息中手动触发上下文推断后再确认。",
      status: "open",
    });
  }
}

export function addAiFailurePendingItems(imported, pendingItems, { makeId } = {}) {
  for (const photo of imported.filter(hasAiProcessingFailure)) {
    const failedParts = [photo.aiFailure?.vision ? "AI Vision" : undefined, photo.aiFailure?.embedding ? "Embedding" : undefined].filter(Boolean).join(" / ");
    const gpsLabel = photo.aiFailure?.hasRealExifGps ? "真实GPS" : "无GPS";
    pendingItems.push({
      id: makeId("pending"),
      type: "ai_processing_failed",
      relatedPhotoIds: [photo.id],
      relatedTripId: photo.tripId,
      suggestion: `${photo.title ?? photo.fileName} 初次导入 ${failedParts || "AI"} 处理失败，需要选择处理方式。`,
      reason: `${gpsLabel}。${[
        photo.aiFailure?.vision ? `AI Vision：${photo.aiFailure.vision}` : undefined,
        photo.aiFailure?.embedding ? `Embedding：${photo.aiFailure.embedding}` : undefined,
      ]
        .filter(Boolean)
        .join("；")}`,
      status: "open",
      proposal: {
        action: "resolve_ai_processing_failed",
        photoIds: [photo.id],
      },
    });
  }
}

export function appendMissingInfoPendingIfNeeded(state, batch, photo, { makeId, completeCandidatePoint } = {}) {
  if (hasAiProcessingFailure(photo) || !hasMissingImportInfo(photo)) return state;
  const alreadyOpen = state.pendingItems.some(
    (item) => item.status === "open" && batch.pendingItemIds.includes(item.id) && ["missing_gps", "missing_time", "confirm_location_candidate"].includes(item.type) && item.relatedPhotoIds?.includes(photo.id),
  );
  if (alreadyOpen) return state;
  const nextItems = [];
  addLocationPendingItems([photo], nextItems, { makeId, completeCandidatePoint });
  addMissingInfoPendingItems([photo], nextItems, { makeId });
  if (!nextItems.length) return state;
  return {
    ...state,
    pendingItems: [...state.pendingItems, ...nextItems],
    importBatches: state.importBatches.map((item) => (item.id === batch.id ? { ...item, pendingItemIds: [...item.pendingItemIds, ...nextItems.map((pendingItem) => pendingItem.id)] } : item)),
  };
}

export function confirmImportState(state, id) {
  const batch = state.importBatches.find((item) => item.id === id);
  if (!batch || batch.status !== "pending_confirmation") return state;
  const openMissingItems = state.pendingItems.filter(
    (item) => batch.pendingItemIds.includes(item.id) && item.status === "open" && blockingImportPendingTypes.includes(item.type),
  );
  if (openMissingItems.length) throw new Error("仍有待补信息或 AI 初次处理失败照片未处理，不能确认导入。");
  return {
    ...state,
    trips: state.trips.map((trip) => (batch.createdTripIds.includes(trip.id) ? { ...trip, status: "confirmed" } : trip)),
    importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "confirmed" } : item)),
  };
}

export function rollbackImportState(state, id, { makeId } = {}) {
  const batch = state.importBatches.find((item) => item.id === id);
  const latestPending = latestPendingImportBatch(state);
  if (!batch || batch.id !== latestPending?.id) throw new Error("MVP 只支持回撤最近一次待确认导入。");
  const photoIds = new Set(safeArray(batch.addedPhotoIds));
  const tripIds = new Set(safeArray(batch.createdTripIds));
  const affectedExistingTripIds = new Set(safeArray(batch.updatedTripIds));
  const pendingIds = new Set(safeArray(batch.pendingItemIds));
  const removedPhotos = state.photos.filter((photo) => photoIds.has(photo.id));
  const base = {
    ...state,
    photos: state.photos.filter((photo) => !photoIds.has(photo.id)),
    trips: state.trips.filter((trip) => !tripIds.has(trip.id)),
    placeNodes: state.placeNodes.filter((place) => !tripIds.has(place.tripId)),
    routes: state.routes.filter((route) => !tripIds.has(route.tripId)),
    pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
    importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "rolled_back" } : item)),
  };
  return {
    state: rebuildTrips(base, affectedExistingTripIds, { makeId }),
    batch,
    removedPhotos,
    removedPhotoIds: Array.from(photoIds),
    storedFileNames: safeArray(batch.storedFileNames),
    storedThumbnailNames: safeArray(batch.storedThumbnailNames),
  };
}

export function cancelImportPhotosState(state, batchId, body = {}, { makeId } = {}) {
  const batch = state.importBatches.find((item) => item.id === batchId);
  const latestPending = latestPendingImportBatch(state);
  if (!batch || batch.id !== latestPending?.id) throw new Error("只能从最近一次待确认导入中取消照片。");
  const requested = new Set(safeArray(Array.isArray(body) ? body : body.photoIds));
  const batchPhotoIds = new Set(safeArray(batch.addedPhotoIds));
  const cancelIds = new Set([...requested].filter((id) => batchPhotoIds.has(id)));
  if (cancelIds.size === 0) return { state, batch, canceledPhotos: [], canceledPhotoIds: [] };

  const cancelPhotos = state.photos.filter((photo) => cancelIds.has(photo.id));
  const affectedTripIds = new Set(cancelPhotos.map((photo) => photo.tripId).filter(Boolean));
  const remainingAddedPhotoIds = safeArray(batch.addedPhotoIds).filter((id) => !cancelIds.has(id));
  const emptyCreatedTripIds = new Set(
    safeArray(batch.createdTripIds).filter((tripId) => !state.photos.some((photo) => photo.tripId === tripId && !cancelIds.has(photo.id))),
  );
  for (const tripId of emptyCreatedTripIds) affectedTripIds.delete(tripId);

  const pendingItems = state.pendingItems
    .map((item) => {
      if (!batch.pendingItemIds.includes(item.id)) return item;
      const relatedPhotoIds = safeArray(item.relatedPhotoIds).filter((id) => !cancelIds.has(id));
      return { ...item, relatedPhotoIds };
    })
    .filter((item) => !batch.pendingItemIds.includes(item.id) || safeArray(item.relatedPhotoIds).length > 0);
  const pendingIds = new Set(pendingItems.filter((item) => batch.pendingItemIds.includes(item.id)).map((item) => item.id));

  const canceledMissingCount = cancelPhotos.filter((photo) => photo.pendingReason).length;
  const canceledSuccessCount = cancelIds.size - canceledMissingCount;
  const patchedBatch = {
    ...batch,
    totalCount: Math.max(0, batch.totalCount - cancelIds.size),
    successCount: Math.max(0, batch.successCount - canceledSuccessCount),
    failedCount: Math.max(0, batch.failedCount - canceledMissingCount),
    createdTripIds: safeArray(batch.createdTripIds).filter((id) => !emptyCreatedTripIds.has(id)),
    addedPhotoIds: remainingAddedPhotoIds,
    pendingItemIds: safeArray(batch.pendingItemIds).filter((id) => pendingIds.has(id)),
    storedFileNames: safeArray(batch.storedFileNames),
    storedThumbnailNames: safeArray(batch.storedThumbnailNames),
    status: remainingAddedPhotoIds.length > 0 ? batch.status : "rolled_back",
    summary: `${batch.summary} 已取消 ${cancelIds.size} 张待补照片。`,
  };
  const base = {
    ...state,
    photos: state.photos.filter((photo) => !cancelIds.has(photo.id)),
    trips: state.trips.filter((trip) => !emptyCreatedTripIds.has(trip.id)),
    placeNodes: state.placeNodes.filter((place) => !emptyCreatedTripIds.has(place.tripId)).map((place) => ({ ...place, photoIds: place.photoIds.filter((id) => !cancelIds.has(id)) })),
    routes: state.routes.filter((route) => !emptyCreatedTripIds.has(route.tripId)),
    pendingItems,
    importBatches: state.importBatches.map((item) => (item.id === batchId ? patchedBatch : item)),
  };
  return {
    state: rebuildTrips(base, affectedTripIds, { makeId }),
    batch: patchedBatch,
    canceledPhotos: cancelPhotos,
    canceledPhotoIds: Array.from(cancelIds),
  };
}

export function mergeImportTripsState(state, batchId) {
  const batch = state.importBatches.find((item) => item.id === batchId);
  if (!batch || batch.createdTripIds.length <= 1) return state;
  const [targetTripId, ...removeTripIds] = batch.createdTripIds;
  const removeSet = new Set(removeTripIds);
  const batchPhotos = state.photos.filter((photo) => batch.addedPhotoIds.includes(photo.id));
  const dates = batchPhotos.map((photo) => photo.capturedAt).filter(Boolean).sort();
  const placeNodes = state.placeNodes.map((place) => (removeSet.has(place.tripId) ? { ...place, tripId: targetTripId } : place));
  const targetPlaces = placeNodes.filter((place) => place.tripId === targetTripId);
  const routes = state.routes.filter((route) => !batch.createdTripIds.includes(route.tripId)).concat(buildRoute(targetTripId, targetPlaces));
  return {
    ...state,
    photos: state.photos.map((photo) => (batch.addedPhotoIds.includes(photo.id) ? { ...photo, tripId: targetTripId } : photo)),
    trips: state.trips
      .filter((trip) => !removeSet.has(trip.id))
      .map((trip) =>
        trip.id === targetTripId
          ? {
              ...trip,
              title: trip.title.replace(/\s+\d+$/, ""),
              dateRange: { start: toDateInput(dates[0]), end: toDateInput(dates.at(-1)) },
              cities: Array.from(new Set(state.trips.filter((item) => batch.createdTripIds.includes(item.id)).flatMap((item) => item.cities))),
              countries: Array.from(new Set(state.trips.filter((item) => batch.createdTripIds.includes(item.id)).flatMap((item) => item.countries))),
            }
          : trip,
      ),
    placeNodes,
    routes,
    importBatches: state.importBatches.map((item) => (item.id === batchId ? { ...item, createdTripIds: [targetTripId], summary: `${item.summary} 已按用户选择合并为一个旅行档案。` } : item)),
    pendingItems: state.pendingItems.map((item) => (item.type === "split_suggestion" && batch.pendingItemIds.includes(item.id) ? { ...item, status: "accepted" } : item)),
  };
}

export function buildImportStateFromPhotos(
  state,
  {
    totalCount,
    photos,
    duplicateCount = 0,
    duplicatePhotoIds = [],
    duplicateNames = [],
    batchId,
    makeId,
    now = new Date(),
    locale = "zh",
    aiStats,
    storedFileNames = [],
    storedThumbnailNames = [],
    completeCandidatePoint,
  } = {},
) {
  if (typeof makeId !== "function") throw new TypeError("buildImportStateFromPhotos requires makeId");
  const resolvedBatchId = batchId ?? makeId("batch");
  const imported = photos.slice();
  const groups = imported.length ? groupImportedPhotos(imported) : [];
  const createdTrips = [];
  const updatedTripIds = new Set();
  const pendingItems = [];
  let workingTrips = state.trips.slice();
  let workingPhotos = [...state.photos, ...imported];
  let workingPlaceNodes = state.placeNodes.slice();
  let workingRoutes = state.routes.slice();

  for (const [groupIndex, group] of groups.entries()) {
    const first = group[0];
    const firstLocated = group.find((photo) => photo.location);
    const preset = inferPreset(first.fileName, firstLocated?.location);
    const start = toDateInput(group[0]?.capturedAt);
    const end = toDateInput(group.at(-1)?.capturedAt);
    const adjacentTrip = findAdjacentTrip({ ...state, trips: workingTrips }, group);
    const tripId = adjacentTrip?.id ?? makeId("trip");
    const title = importTripTitle({ month: start.slice(0, 7), city: preset.city, groupIndex, groupCount: groups.length, locale });
    let trip = adjacentTrip;
    if (!trip) {
      trip = {
        id: tripId,
        title,
        dateRange: { start, end },
        countries: [preset.country],
        cities: [preset.city],
        coverUrl: first.thumbnailUrl,
        photoCount: group.length,
        placeNodeCount: 0,
        status: "pending",
        source: "import",
      };
      createdTrips.push(trip);
      workingTrips.push(trip);
    } else {
      updatedTripIds.add(tripId);
    }
    for (const photo of group) photo.tripId = tripId;
    const tripPhotosAfter = workingPhotos.filter((photo) => photo.tripId === tripId);
    const archivableTripPhotos = tripPhotosAfter.filter((photo) => !hasMissingImportInfo(photo) && !hasAiProcessingFailure(photo));
    const tripLocatedAfter = archivableTripPhotos.filter((photo) => photo.location);
    if (tripLocatedAfter.length) {
      const places = buildPlacesForGroup(archivableTripPhotos, tripId, { makeId, existingPlaces: workingPlaceNodes.filter((place) => place.tripId === tripId) });
      workingPlaceNodes = workingPlaceNodes.filter((place) => place.tripId !== tripId).concat(places);
      workingRoutes = workingRoutes.filter((route) => route.tripId !== tripId).concat(buildPhotoRoute(tripId, tripLocatedAfter));
      for (const photo of tripPhotosAfter) photo.placeNodeId = undefined;
      for (const place of places) {
        for (const photoId of place.photoIds) {
          const photo = tripPhotosAfter.find((item) => item.id === photoId);
          if (photo) photo.placeNodeId = place.id;
        }
      }
    }
    const tripDates = tripPhotosAfter.map((photo) => photo.capturedAt).filter(Boolean).sort();
    const geoSummary = dominantPresetsForPhotos(tripPhotosAfter);
    workingTrips = workingTrips.map((item) =>
      item.id === tripId
        ? {
            ...item,
            title: createdTrips.some((createdTrip) => createdTrip.id === tripId)
              ? importTripTitle({
                  month: toDateInput(tripDates[0]).slice(0, 7),
                  city: geoSummary.cities.length > 1 ? importTripMultiCityLabel(geoSummary.countries, locale) : geoSummary.cities[0],
                  locale,
                })
              : item.title,
            dateRange: { start: toDateInput(tripDates[0] ?? start), end: toDateInput(tripDates.at(-1) ?? end) },
            countries: geoSummary.countries.length ? geoSummary.countries : item.countries,
            cities: geoSummary.cities,
            coverUrl: item.coverUrl || first.thumbnailUrl,
          }
        : item,
    );
    pendingItems.push({
      id: makeId("pending"),
      type: "needs_trip_confirmation",
      relatedPhotoIds: group.map((photo) => photo.id),
      relatedTripId: tripId,
      suggestion: adjacentTrip ? `建议把这次导入追加到已有旅行档案「${adjacentTrip.title}」。` : `建议创建新的旅行档案「${title}」。`,
      reason: "系统基于拍摄时间、GPS/文件名地点线索和 Qwen 标签给出建议，需要用户确认。",
      status: "open",
      proposal: {
        action: "confirm_trip_assignment",
        tripId,
        photoIds: group.map((photo) => photo.id),
      },
    });
  }

  addLocationPendingItems(imported, pendingItems, { makeId, completeCandidatePoint });
  addMissingInfoPendingItems(imported, pendingItems, { makeId });
  addAiFailurePendingItems(imported, pendingItems, { makeId });

  const aiFailures = imported.filter(hasAiProcessingFailure);
  const missing = imported.filter((photo) => hasMissingImportInfo(photo) && !hasAiProcessingFailure(photo));
  if (groups.length > 1 || imported.length >= 6) {
    pendingItems.push({
      id: makeId("pending"),
      type: "split_suggestion",
      relatedPhotoIds: imported.map((photo) => photo.id),
      suggestion: groups.length > 1 ? `这批照片可能包含 ${groups.length} 段旅行，已按明显时间断层拆成多个待确认 Trip。` : "这批照片数量较多，可能包含多段旅行，请确认是否仍保留为当前归档建议。",
      reason: "MVP 使用明显时间断层作为拆分建议依据，不做强制静默拆分。",
      status: "open",
    });
  }
  const recent = imported.some((photo) => Math.abs(now.getTime() - new Date(photo.capturedAt).getTime()) <= 24 * 60 * 60 * 1000);
  if (recent) {
    pendingItems.push({
      id: makeId("pending"),
      type: "recent_import",
      relatedPhotoIds: imported.map((photo) => photo.id),
      relatedTripId: createdTrips[0]?.id,
      suggestion: "这批照片拍摄于最近 24 小时内，可加入当前旅行、新建正在进行的旅行，或暂不归档。",
      reason: "近期照片归属必须由用户确认。",
      status: "open",
    });
  }

  const batch = {
    id: resolvedBatchId,
    importedAt: now.toISOString(),
    totalCount,
    successCount: imported.length - missing.length - aiFailures.length,
    failedCount: missing.length + aiFailures.length,
    duplicateCount,
    duplicatePhotoIds,
    duplicateNames,
    status: imported.length > 0 ? "pending_confirmation" : "confirmed",
    createdTripIds: createdTrips.map((trip) => trip.id),
    updatedTripIds: Array.from(updatedTripIds),
    addedPhotoIds: imported.map((photo) => photo.id),
    pendingItemIds: pendingItems.map((item) => item.id),
    storedFileNames,
    storedThumbnailNames,
    aiStats: aiStats ?? {
      qwenCount: 0,
      fallbackCount: imported.length,
      embeddingCount: 0,
      qwenEmbeddingCount: 0,
      deterministicEmbeddingCount: 0,
    },
    summary: importSummary({
      importedCount: imported.length,
      duplicateCount,
      createdTripCount: createdTrips.length,
      missingCount: missing.length,
      aiFailureCount: aiFailures.length,
      reanalyzedCount: Number(aiStats?.qwenCount ?? 0) + Number(aiStats?.fallbackCount ?? 0),
    }),
  };

  return {
    trips: workingTrips,
    photos: workingPhotos,
    placeNodes: workingPlaceNodes,
    routes: workingRoutes,
    importBatches: [...state.importBatches, batch],
    pendingItems: [...state.pendingItems, ...pendingItems],
  };
}

function importSummary({ importedCount, duplicateCount, createdTripCount, missingCount, aiFailureCount, reanalyzedCount = 0 }) {
  if (importedCount > 0) {
    return `新增 ${importedCount} 张照片，跳过 ${duplicateCount} 张重复照片，创建 ${createdTripCount} 个待确认旅行档案，${missingCount} 张需要补充时间或地点，${aiFailureCount} 张 AI 初次处理失败。`;
  }
  return reanalyzedCount > 0
    ? `没有新增照片，已跳过 ${duplicateCount} 张重复照片；其中 ${reanalyzedCount} 张完成了 AI 重新分析。`
    : `没有新增照片，已跳过 ${duplicateCount} 张重复照片。`;
}
