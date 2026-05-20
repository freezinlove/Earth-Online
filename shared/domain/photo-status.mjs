export function hasAiProcessingFailure(photo) {
  return Boolean(photo?.aiFailure?.vision || photo?.aiFailure?.embedding || photo?.pendingReason === "ai_processing_failed");
}

export function hasMissingImportInfo(photo) {
  return photo?.pendingReason === "missing_gps" || photo?.pendingReason === "missing_time" || photo?.exifStatus?.gps === "missing" || photo?.exifStatus?.time !== "read";
}
