import { safeArray } from "./arrays.mjs";

function hasAiProcessingFailure(photo) {
  return Boolean(photo?.aiFailure?.vision || photo?.aiFailure?.embedding || photo?.pendingReason === "ai_processing_failed");
}

function reconcileResolvedAiFailurePendingItems(pendingItems, photos) {
  const photosById = new Map(photos.map((photo) => [photo.id, photo]));
  return pendingItems.map((item) => {
    if (item?.type !== "ai_processing_failed" || item.status !== "open") return item;
    const relatedPhotos = safeArray(item.relatedPhotoIds).map((id) => photosById.get(id)).filter(Boolean);
    if (!relatedPhotos.length || relatedPhotos.some(hasAiProcessingFailure)) return item;
    return {
      ...item,
      status: "accepted",
      reason: item.reason ? `${item.reason}（已检测到照片 AI 结果恢复，自动关闭此失败项。）` : "已检测到照片 AI 结果恢复，自动关闭此失败项。",
    };
  });
}

export function normalizeState(state) {
  const photos = safeArray(state.photos);
  const placeNodes = safeArray(state.placeNodes);
  const pendingItems = reconcileResolvedAiFailurePendingItems(safeArray(state.pendingItems), photos);
  const trips = safeArray(state.trips).map((trip) => ({
    ...trip,
    photoCount: photos.filter((photo) => photo.tripId === trip.id).length,
    placeNodeCount: placeNodes.filter((place) => place.tripId === trip.id).length,
  }));
  return {
    trips,
    photos,
    placeNodes,
    routes: safeArray(state.routes),
    importBatches: safeArray(state.importBatches),
    pendingItems,
  };
}
