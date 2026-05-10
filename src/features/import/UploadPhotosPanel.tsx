import { AlertTriangle, Check, Circle, Clock3, FileImage, FolderOpen, ImagePlus, LoaderCircle, MapPin, PencilLine, RotateCcw, Sparkles, X } from "lucide-react";
import type { ChangeEvent, DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { capturedDateLabel } from "@/domain/datetime";
import { photoAltText, placeLabel, tripLabel } from "@/domain/labels";
import { useI18n } from "@/i18n/useI18n";
import type { MessageKey } from "@/i18n/messages";
import type { ImportBatch, PendingItem, Photo, PlaceNode, Trip } from "@/domain/models";
import type { ImportJobProgress } from "@/services/apiClient";
import { useAppStore } from "@/store/appStore";

type ImportStep = {
  icon: typeof FileImage;
  label: string;
  done?: number;
  total?: number;
  active?: boolean;
};

type PlacePreview = {
  place?: PlaceNode;
  label: string;
  isNew: boolean;
  photos: Photo[];
  timeLabel: string;
};

type TripPreview = {
  trip: Trip;
  isNew: boolean;
  places: PlacePreview[];
};

type MissingPreview = {
  id: string;
  icon: string;
  label: string;
  target: string;
  photos: Photo[];
  confidence?: number;
  pending?: PendingItem;
};

type AiFailurePreview = {
  id: string;
  label: string;
  error: string;
  hasRealExifGps: boolean;
  photo: Photo;
  pending?: PendingItem;
};

type MissingTargetDisplay = {
  label: string;
  badge?: string;
};

type InferFeedback = {
  status: "running" | "error";
  message: string;
};

const previewExitMs = 180;

function isPendingBatch(batch?: ImportBatch) {
  return batch?.status === "pending_confirmation";
}

function shortDate(value?: string) {
  if (!value) return "";
  return capturedDateLabel(value).replace(/-/g, ".").slice(5);
}

function compactTimeLabel(start?: string, end?: string) {
  const startDate = shortDate(start);
  const endDate = shortDate(end);
  if (!startDate && !endDate) return undefined;
  if (startDate && endDate && startDate !== endDate) return `${startDate}-${endDate}`;
  return startDate || endDate;
}

function photosTimeLabel(photos: Photo[]) {
  const dates = photos.map((photo) => photo.capturedAt).filter(Boolean).sort();
  return compactTimeLabel(dates[0], dates[dates.length - 1]);
}

function bestCandidate(photo: Photo) {
  return [...(photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [])].sort((left, right) => right.confidence - left.confidence)[0];
}

function needsGps(photo: Photo) {
  if (!photo.pendingReason && photo.locationResolution?.source === "manual_archived_unlocated") return false;
  return photo.pendingReason === "missing_gps" || photo.exifStatus?.gps === "missing" || photo.locationResolution?.status === "missing";
}

function needsTime(photo: Photo) {
  return photo.pendingReason === "missing_time" || photo.exifStatus?.time === "missing";
}

function hasMissingInfo(photo: Photo) {
  return needsGps(photo) || needsTime(photo);
}

function hasAiFailure(photo: Photo) {
  return Boolean(photo.aiFailure?.vision || photo.aiFailure?.embedding || photo.pendingReason === "ai_processing_failed");
}

function isMissingInfoPending(item: PendingItem) {
  return item.type === "missing_gps" || item.type === "missing_time" || item.type === "confirm_location_candidate";
}

function isAiFailurePending(item: PendingItem) {
  return item.type === "ai_processing_failed";
}

function aiFailureLabel(photo: Photo, t: (key: MessageKey) => string) {
  const vision = Boolean(photo.aiFailure?.vision);
  const embedding = Boolean(photo.aiFailure?.embedding);
  if (vision && embedding) return t("aiBothFailed");
  if (vision) return t("aiVisionFailed");
  if (embedding) return t("embeddingFailed");
  return t("aiProcessingFailed");
}

function aiFailureError(photo: Photo) {
  return [photo.aiFailure?.vision ? `AI Vision: ${photo.aiFailure.vision}` : undefined, photo.aiFailure?.embedding ? `Embedding: ${photo.aiFailure.embedding}` : undefined]
    .filter(Boolean)
    .join("；");
}

function photoSuggestionTarget(photo: Photo) {
  const candidate = bestCandidate(photo);
  return photo.locationResolution?.effectiveName ?? candidate?.name ?? photo.tags.find((tag) => tag !== "旅行" && tag !== "待确认") ?? "待定";
}

function pendingProposalTarget(item: PendingItem | undefined, fallback: string): MissingTargetDisplay {
  const target = item?.inference?.displayTarget;
  if (!item?.inference?.displayTargetLabel && target) {
    const match = target.match(/^(合并|新地点|待确认|仍待确认)\s+(.+)$/);
    if (match) return { label: match[2], badge: match[1] === "仍待确认" ? "待确认" : match[1] };
  }
  return {
    label: item?.inference?.displayTargetLabel ?? item?.inference?.displayTarget ?? fallback,
    badge: item?.inference?.displayTargetBadge,
  };
}

function buildProgressSteps({
  importProgress,
  isImporting,
  latestBatch,
  t,
}: {
  importProgress?: ImportJobProgress;
  isImporting: boolean;
  latestBatch?: ImportBatch;
  t: (key: MessageKey) => string;
}): ImportStep[] {
  const latestTotal = latestBatch?.totalCount ?? 0;
  const liveTotal = Math.max(
    importProgress?.total ?? 0,
    importProgress?.steps?.reading?.total ?? 0,
    importProgress?.steps?.upload?.total ?? 0,
    importProgress?.steps?.exif?.total ?? 0,
    importProgress?.steps?.thumbnails?.total ?? 0,
    importProgress?.steps?.ai?.total ?? 0,
    importProgress?.steps?.embedding?.total ?? 0,
  );
  const completed = Boolean(latestBatch && !isImporting);

  if ((isImporting && importProgress) || completed) {
    const progressTotal = isImporting ? liveTotal : latestTotal;
    const total = Math.max(progressTotal, 1);
    const phase = completed ? "completed" : importProgress?.phase;
    const uploadDone = importProgress?.steps?.upload?.done ?? importProgress?.steps?.reading?.done ?? (phase === "reading" || phase === "uploading" ? importProgress?.done ?? 0 : total);
    const exifDone =
      importProgress?.steps?.exif?.done ??
      (phase === "exif" ? importProgress?.done ?? 0 : phase === "thumbnails" || phase === "ai" || phase === "embedding" || phase === "grouping" || phase === "completed" ? total : 0);
    const thumbnailDone =
      importProgress?.steps?.thumbnails?.done ??
      (phase === "thumbnails" ? importProgress?.done ?? 0 : phase === "ai" || phase === "embedding" || phase === "grouping" || phase === "completed" ? total : 0);
    const aiDone =
      importProgress?.steps?.ai?.done ??
      (phase === "ai" ? importProgress?.done ?? 0 : phase === "embedding" || phase === "grouping" || phase === "completed" ? total : 0);
    const embeddingDone =
      importProgress?.steps?.embedding?.done ??
      (phase === "embedding" ? importProgress?.done ?? 0 : phase === "grouping" || phase === "completed" ? total : 0);

    return [
      { icon: FileImage, label: t("uploadPhotos"), done: Math.min(uploadDone, total), total, active: phase === "reading" || phase === "uploading" },
      { icon: Clock3, label: t("parseExif"), done: Math.min(exifDone, total), total, active: phase === "exif" },
      { icon: ImagePlus, label: t("generateThumbnails"), done: Math.min(thumbnailDone, total), total, active: phase === "thumbnails" },
      { icon: Sparkles, label: t("aiImageUnderstanding"), done: Math.min(aiDone, total), total, active: phase === "ai" },
      { icon: Circle, label: t("generateVectors"), done: Math.min(embeddingDone, total), total, active: phase === "embedding" },
    ];
  }

  return [];
}

function buildTripPreview({
  batch,
  photos,
  placeNodes,
  trips,
  locale,
  t,
}: {
  batch?: ImportBatch;
  photos: Photo[];
  placeNodes: PlaceNode[];
  trips: Trip[];
  locale: ReturnType<typeof useI18n>["locale"];
  t: (key: MessageKey) => string;
}): TripPreview[] {
  if (!batch) return [];
  const importedPhotoIds = new Set(batch.addedPhotoIds);
  const importedPhotos = photos.filter((photo) => importedPhotoIds.has(photo.id));
  const archivablePhotos = importedPhotos.filter((photo) => !hasMissingInfo(photo) && !hasAiFailure(photo));
  const createdTripIds = new Set(batch.createdTripIds);
  const tripIds = new Set(archivablePhotos.map((photo) => photo.tripId).filter((id): id is string => Boolean(id)));

  return [...tripIds]
    .map((tripId) => {
      const trip = trips.find((item) => item.id === tripId);
      if (!trip) return undefined;
      const tripPhotos = archivablePhotos.filter((photo) => photo.tripId === trip.id);
      const places = placeNodes
        .filter((place) => place.tripId === trip.id && place.photoIds.some((id) => importedPhotoIds.has(id)))
        .sort((left, right) => (left.timeRange.start ?? "").localeCompare(right.timeRange.start ?? ""))
        .map<PlacePreview>((place) => {
          const placePhotoIds = new Set(place.photoIds);
          const placePhotos = tripPhotos.filter((photo) => placePhotoIds.has(photo.id));
          return {
            place,
            label: placeLabel(place, locale),
            isNew: createdTripIds.has(trip.id) || place.photoIds.every((id) => importedPhotoIds.has(id)) || place.pending,
            photos: placePhotos,
            timeLabel: compactTimeLabel(place.timeRange.start, place.timeRange.end) ?? t("timeMissing"),
          };
        });
      const placedPhotoIds = new Set(places.flatMap((place) => place.photos.map((photo) => photo.id)));
      const unplacedPhotos = tripPhotos.filter((photo) => !placedPhotoIds.has(photo.id));

      if (unplacedPhotos.length) {
        places.push({
          label: t("undecided"),
          isNew: true,
          photos: unplacedPhotos,
          timeLabel: photosTimeLabel(unplacedPhotos) ?? t("timeMissing"),
        });
      }

      return {
        trip,
        isNew: createdTripIds.has(trip.id),
        places: places.sort((left, right) => (left.timeLabel === t("timeMissing") ? "99.99" : left.timeLabel).localeCompare(right.timeLabel === t("timeMissing") ? "99.99" : right.timeLabel)),
      };
    })
    .filter((item): item is TripPreview => Boolean(item))
    .sort((left, right) => left.trip.dateRange.start.localeCompare(right.trip.dateRange.start));
}

function groupMissingPreviews(batch: ImportBatch | undefined, photos: Photo[], pendingItems: PendingItem[], t: (key: MessageKey) => string): MissingPreview[] {
  if (!batch) return [];
  const importedIds = new Set(batch.addedPhotoIds);
  const imported = photos.filter((photo) => importedIds.has(photo.id));
  const pendingByPhoto = new Map<string, PendingItem>();
  for (const item of pendingItems) {
    if (!batch.pendingItemIds.includes(item.id) || item.status !== "open") continue;
    if (!isMissingInfoPending(item)) continue;
    for (const photoId of item.relatedPhotoIds) {
      const current = pendingByPhoto.get(photoId);
      if (!current || (!current.inference && item.inference) || (!current.proposal && item.proposal)) pendingByPhoto.set(photoId, item);
    }
  }

  return imported
    .map<MissingPreview | undefined>((photo) => {
    const gps = needsGps(photo);
    const time = needsTime(photo);
      if (hasAiFailure(photo) || (!gps && !time)) return undefined;

    const target = gps && time ? `${photoSuggestionTarget(photo)} · ${shortDate(photo.capturedAt)}` : gps ? photoSuggestionTarget(photo) : shortDate(photo.capturedAt);
    const icon = gps && time ? "⌖◷" : gps ? "⌖" : "◷";
    const candidate = bestCandidate(photo);
      return {
        id: photo.id,
        icon,
        label: gps && time ? t("missingGpsTime") : gps ? t("missingGps") : t("missingTime"),
        target,
        photos: [photo],
        confidence: candidate?.confidence ?? photo.locationResolution?.confidence,
        pending: pendingByPhoto.get(photo.id),
      };
    })
    .filter((item): item is MissingPreview => Boolean(item));
}

function groupAiFailurePreviews(batch: ImportBatch | undefined, photos: Photo[], pendingItems: PendingItem[], t: (key: MessageKey) => string): AiFailurePreview[] {
  if (!batch) return [];
  const importedIds = new Set(batch.addedPhotoIds);
  const pendingByPhoto = new Map<string, PendingItem>();
  for (const item of pendingItems) {
    if (!batch.pendingItemIds.includes(item.id) || item.status !== "open" || !isAiFailurePending(item)) continue;
    for (const photoId of item.relatedPhotoIds) pendingByPhoto.set(photoId, item);
  }
  return photos
    .filter((photo) => importedIds.has(photo.id) && pendingByPhoto.has(photo.id))
    .map((photo) => ({
      id: photo.id,
      label: aiFailureLabel(photo, t),
      error: aiFailureError(photo) || pendingByPhoto.get(photo.id)?.reason || t("failed"),
      hasRealExifGps: Boolean(photo.aiFailure?.hasRealExifGps || photo.exifStatus?.gps === "read"),
      photo,
      pending: pendingByPhoto.get(photo.id),
    }));
}

function PhotoStrip({
  photos,
  onRemovePhoto,
  selectedPhotoId,
  onOpenPreview,
  onSelect,
  t,
}: {
  photos: Photo[];
  onRemovePhoto?: (photoId: string) => void;
  selectedPhotoId?: string;
  onOpenPreview?: (photo: Photo) => void;
  onSelect: (photoId: string) => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <div className="import-photo-strip">
      {photos.map((photo) => (
        <span key={photo.id} className="import-thumb-shell" data-active={selectedPhotoId === photo.id || undefined}>
          <button
            className="import-thumb"
            onClick={() => {
              onSelect(photo.id);
              onOpenPreview?.(photo);
            }}
            title={photo.fileName}
            type="button"
          >
            <img src={photo.thumbnailUrl} alt={photoAltText(photo)} />
          </button>
          {onRemovePhoto ? (
            <button
              className="import-thumb-remove"
              onClick={(event) => {
                event.stopPropagation();
                onRemovePhoto(photo.id);
              }}
              title={t("removePhoto")}
              type="button"
              aria-label={`${t("clear")} ${photo.title ?? photo.fileName}`}
            >
              <X size={12} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function ProgressLine({ step }: { step: ImportStep }) {
  const Icon = step.icon;
  const hasMeter = typeof step.done === "number" && typeof step.total === "number";
  const total = Math.max(1, step.total ?? 1);
  const width = hasMeter ? Math.max(step.done && step.done > 0 ? 8 : 0, Math.min(100, ((step.done ?? 0) / total) * 100)) : 0;

  return (
    <div className="import-progress-line" data-active={step.active || undefined} title={step.label}>
      <Icon size={15} />
      <span className="import-progress-label">{step.label}</span>
      <span className="import-progress-track">
        <span style={{ width: `${width}%` }} />
      </span>
      <strong>{hasMeter ? `${step.done}/${step.total}` : ""}</strong>
    </div>
  );
}

function ReviewTree({
  previews,
  selectedPhotoId,
  onOpenPreview,
  onRemovePhoto,
  onSelectPhoto,
  t,
}: {
  previews: TripPreview[];
  selectedPhotoId?: string;
  onOpenPreview: (photo: Photo) => void;
  onRemovePhoto?: (photoId: string) => void;
  onSelectPhoto: (photoId: string) => void;
  t: (key: MessageKey) => string;
}) {
  if (!previews.length) return null;

  return (
    <section className="import-review-tree" aria-label={t("archiveTree")}>
      {previews.map((preview) => (
        <div key={preview.trip.id} className="import-trip-node" data-new={preview.isNew || undefined}>
          <div className="import-node-label import-node-label-trip">
            {preview.isNew ? <Circle size={12} /> : <span className="import-solid-dot" />}
            <span>{tripLabel(preview.trip)}</span>
            <em>{preview.isNew ? t("newTrip") : t("existingTrip")}</em>
          </div>
          <div className="import-place-branch">
            {preview.places.map((placePreview) => (
              <div key={placePreview.place?.id ?? `${preview.trip.id}-${placePreview.label}`} className="import-place-node" data-new={placePreview.isNew || undefined}>
                <div className="import-node-label">
                  {placePreview.isNew ? <Circle size={10} /> : <span className="import-solid-dot import-solid-dot-small" />}
                  <MapPin size={14} />
                  <span>{placePreview.label}</span>
                  <em>{placePreview.isNew ? t("newPlace") : t("merge")}</em>
                  <time>{placePreview.timeLabel}</time>
                </div>
                <PhotoStrip photos={placePreview.photos} selectedPhotoId={selectedPhotoId} onOpenPreview={onOpenPreview} onRemovePhoto={onRemovePhoto} onSelect={onSelectPhoto} t={t} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function MissingSuggestions({
  groups,
  inferFeedback,
  inferringIds,
  acceptingIds,
  selectedPhotoId,
  onAccept,
  onInfer,
  onManual,
  onOpenPreview,
  onReject,
  onSelectPhoto,
  t,
}: {
  groups: MissingPreview[];
  inferFeedback: Record<string, InferFeedback>;
  inferringIds: Set<string>;
  acceptingIds: Set<string>;
  selectedPhotoId?: string;
  onAccept: (item?: PendingItem) => void;
  onInfer: (item?: PendingItem) => void;
  onManual: (item?: PendingItem) => void;
  onOpenPreview: (photo: Photo) => void;
  onReject: (photoIds: string[]) => void;
  onSelectPhoto: (photoId: string) => void;
  t: (key: MessageKey) => string;
}) {
  if (!groups.length) return null;
  const allPhotoIds = groups.flatMap((group) => group.photos.map((photo) => photo.id));
  const inferableItems = Array.from(
    new Map(
      groups
        .map((group) => group.pending)
        .filter((item): item is PendingItem => Boolean(item))
        .map((item) => [item.id, item]),
    ).values(),
  );
  const hasInferable = inferableItems.some((item) => !inferringIds.has(item.id));

  return (
    <section className="import-missing" aria-label={t("pendingSuggestions")}>
      <div className="import-missing-heading">
        <span>{t("pendingInfo")}</span>
        <small>{groups.reduce((count, group) => count + group.photos.length, 0)} {t("photoCount")}</small>
        <div className="import-missing-heading-actions">
          <button onClick={() => onReject(allPhotoIds)} disabled={!allPhotoIds.length} title={t("cancelImport")} type="button">
            <X size={14} />
          </button>
          <button
            onClick={() => inferableItems.forEach((item) => {
              if (!inferringIds.has(item.id)) onInfer(item);
            })}
            disabled={!hasInferable}
            title={t("aiSecondInference")}
            type="button"
          >
            <Sparkles size={14} />
          </button>
        </div>
      </div>
      <div className="import-missing-list">
        {groups.map((group) => {
          const isInferring = Boolean(group.pending && inferringIds.has(group.pending.id));
          const isAccepting = Boolean(group.pending && acceptingIds.has(group.pending.id));
          const actionable = Boolean(group.pending?.proposal && group.pending.proposal.action !== "keep_pending");
          const suggestedTarget = pendingProposalTarget(group.pending, group.target);
          const feedback = group.pending ? inferFeedback[group.pending.id] : undefined;
          const statusLabel =
            feedback?.status === "running"
              ? t("inferring")
              : feedback?.status === "error"
                ? t("failed")
                : isInferring
                  ? t("inferring")
                  : actionable
                    ? t("aiSuggestion")
                    : group.pending?.inference?.status === "keep_pending"
                      ? t("stillPending")
                      : t("waitingInference");
          return (
            <div key={group.id} className="import-missing-row" title={group.pending?.reason ?? group.label}>
              <PhotoStrip photos={group.photos} selectedPhotoId={selectedPhotoId} onOpenPreview={onOpenPreview} onSelect={onSelectPhoto} t={t} />
              <span className="import-missing-field">{group.label}</span>
              <span className="import-ai-suggest" data-status={statusLabel}>{statusLabel}</span>
              <strong className="import-missing-target">
                <span>{suggestedTarget.label}</span>
                {suggestedTarget.badge ? <em>{suggestedTarget.badge}</em> : null}
              </strong>
              <button className="import-inline-cancel" onClick={() => onReject(group.photos.map((photo) => photo.id))} title={t("cancelImport")} type="button">
                <X size={13} />
              </button>
              <button className="import-inline-infer" onClick={() => onInfer(group.pending)} disabled={!group.pending || isInferring} title={t("aiSecondInference")} type="button" data-tooltip={t("aiSecondInference")}>
                {isInferring ? <LoaderCircle className="animate-spin" size={13} /> : <Sparkles size={13} />}
              </button>
              <button className="import-inline-manual" onClick={() => onManual(group.pending)} disabled={!group.pending || isAccepting} title={t("manualResolve")} type="button">
                <PencilLine size={13} />
              </button>
              {actionable ? (
                <button className="import-inline-confirm" onClick={() => onAccept(group.pending)} disabled={isAccepting} title={t("confirmSuggestion")} type="button">
                  {isAccepting ? <LoaderCircle className="animate-spin" size={13} /> : <Check size={14} />}
                </button>
              ) : null}
              {feedback?.message ? (
                <span className="import-infer-note" data-status={feedback.status}>{feedback.message}</span>
              ) : group.pending?.inference?.reason ? (
                <span className="import-infer-note" data-status={group.pending.inference.status === "keep_pending" ? "error" : "done"}>
                  {group.pending.inference.reason}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AiFailureSuggestions({
  failures,
  acceptingIds,
  selectedPhotoId,
  onManual,
  onOpenPreview,
  onReject,
  onResolve,
  onSelectPhoto,
  t,
}: {
  failures: AiFailurePreview[];
  acceptingIds: Set<string>;
  selectedPhotoId?: string;
  onManual: (item?: PendingItem) => void;
  onOpenPreview: (photo: Photo) => void;
  onReject: (photoIds: string[]) => void;
  onResolve: (item: PendingItem | undefined, action: "retry_vision" | "retry_embedding" | "retry_both" | "archive_exif") => void;
  onSelectPhoto: (photoId: string) => void;
  t: (key: MessageKey) => string;
}) {
  if (!failures.length) return null;

  return (
    <section className="import-missing import-ai-failures" aria-label={t("aiProcessingFailures")}>
      <div className="import-missing-heading">
        <span>{t("aiProcessingFailures")}</span>
        <small>{failures.length} {t("photoCount")}</small>
      </div>
      <div className="import-missing-list">
        {failures.map((failure) => {
          const isBusy = Boolean(failure.pending && acceptingIds.has(failure.pending.id));
          const canRetryVision = Boolean(failure.photo.aiFailure?.vision);
          const canRetryEmbedding = Boolean(failure.photo.aiFailure?.embedding);
          return (
            <div key={failure.id} className="import-missing-row" title={failure.error}>
              <PhotoStrip photos={[failure.photo]} selectedPhotoId={selectedPhotoId} onOpenPreview={onOpenPreview} onSelect={onSelectPhoto} t={t} />
              <span className="import-missing-field">{failure.label}</span>
              <span className="import-ai-suggest" data-status={t("failed")}>
                <AlertTriangle size={13} />
                {failure.hasRealExifGps ? t("hasRealExifGps") : t("noRealExifGps")}
              </span>
              <strong className="import-missing-target">
                <span>{failure.photo.title ?? failure.photo.fileName}</span>
                <em>{failure.hasRealExifGps ? "EXIF" : t("undecided")}</em>
              </strong>
              <button className="import-inline-cancel" onClick={() => onReject([failure.photo.id])} title={t("cancelImport")} type="button">
                <X size={13} />
              </button>
              {canRetryVision && canRetryEmbedding ? (
                <button className="import-inline-infer" onClick={() => onResolve(failure.pending, "retry_both")} disabled={!failure.pending || isBusy} title={t("retryBothAi")} type="button">
                  {isBusy ? <LoaderCircle className="animate-spin" size={13} /> : <Sparkles size={13} />}
                </button>
              ) : null}
              {canRetryVision && !canRetryEmbedding ? (
                <button className="import-inline-infer" onClick={() => onResolve(failure.pending, "retry_vision")} disabled={!failure.pending || isBusy} title={t("retryAiVision")} type="button">
                  {isBusy ? <LoaderCircle className="animate-spin" size={13} /> : <Sparkles size={13} />}
                </button>
              ) : null}
              {canRetryEmbedding && !canRetryVision ? (
                <button className="import-inline-infer" onClick={() => onResolve(failure.pending, "retry_embedding")} disabled={!failure.pending || isBusy} title={t("retryEmbedding")} type="button">
                  {isBusy ? <LoaderCircle className="animate-spin" size={13} /> : <Circle size={13} />}
                </button>
              ) : null}
              {failure.hasRealExifGps ? (
                <button className="import-inline-confirm" onClick={() => onResolve(failure.pending, "archive_exif")} disabled={!failure.pending || isBusy} title={t("archiveByExif")} type="button">
                  <MapPin size={14} />
                </button>
              ) : null}
              <button className="import-inline-manual" onClick={() => onManual(failure.pending)} disabled={!failure.pending || isBusy} title={t("manualResolve")} type="button">
                <PencilLine size={13} />
              </button>
              <span className="import-infer-note" data-status="error">{failure.error}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ManualPendingResolutionModal({
  item,
  locale,
  photos,
  places,
  busy,
  initialName,
  initialMode,
  pickedPoint,
  onClose,
  onPickPoint,
  onSubmit,
  t,
}: {
  item: PendingItem;
  locale: ReturnType<typeof useI18n>["locale"];
  photos: Photo[];
  places: PlaceNode[];
  busy: boolean;
  initialName?: string;
  initialMode?: "bind" | "new" | "archive";
  pickedPoint?: { lat: number; lng: number; nearestLabel?: string };
  onClose: () => void;
  onPickPoint: (pendingId: string, name: string) => void;
  onSubmit: (body: { action: "bind_existing_place"; placeId: string } | { action: "create_manual_place"; name: string; lat: number; lng: number } | { action: "archive_unlocated" }) => void;
  t: (key: MessageKey) => string;
}) {
  const relatedPhotos = photos.filter((photo) => item.relatedPhotoIds.includes(photo.id));
  const primaryPhoto = relatedPhotos[0];
  const tripId = item.relatedTripId ?? primaryPhoto?.tripId;
  const tripPlaces = places.filter((place) => place.tripId === tripId);
  const [mode, setMode] = useState<"bind" | "new" | "archive">("bind");
  const [placeId, setPlaceId] = useState(tripPlaces[0]?.id ?? "");
  const [name, setName] = useState(initialName ?? primaryPhoto?.title ?? primaryPhoto?.fileName ?? "");

  useEffect(() => {
    setPlaceId(tripPlaces[0]?.id ?? "");
    setName(initialName ?? primaryPhoto?.title ?? primaryPhoto?.fileName ?? "");
    setMode(initialMode ?? (tripPlaces.length ? "bind" : "new"));
  }, [initialMode, initialName, item.id]);

  const submit = () => {
    if (mode === "bind") {
      if (placeId) onSubmit({ action: "bind_existing_place", placeId });
      return;
    }
    if (mode === "new") {
      if (!pickedPoint) return;
      onSubmit({ action: "create_manual_place", name, lat: pickedPoint.lat, lng: pickedPoint.lng });
      return;
    }
    onSubmit({ action: "archive_unlocated" });
  };

  return (
    <div className="manual-pending-modal" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <section className="manual-pending-shell" onMouseDown={(event) => event.stopPropagation()}>
        <div className="manual-pending-media">
          {primaryPhoto ? <img src={primaryPhoto.storageUrl ?? primaryPhoto.thumbnailUrl} alt={photoAltText(primaryPhoto)} /> : null}
        </div>
        <div className="manual-pending-copy">
          <div className="manual-pending-heading">
            <h3>{t("manualResolve")}</h3>
            <button className="manual-pending-close" onClick={onClose} type="button" aria-label={t("closePreview")}>
              <X size={18} />
            </button>
          </div>

          <div className="manual-pending-tabs">
            <button type="button" data-active={mode === "bind" || undefined} onClick={() => setMode("bind")} disabled={!tripPlaces.length}>{t("manualMergeExisting")}</button>
            <button type="button" data-active={mode === "new" || undefined} onClick={() => setMode("new")}>{t("manualCreatePlace")}</button>
            <button type="button" data-active={mode === "archive" || undefined} onClick={() => setMode("archive")}>{t("manualArchiveOnly")}</button>
          </div>

          {mode === "bind" ? (
            <label className="manual-pending-field">
              <span>{t("places")}</span>
              <select value={placeId} onChange={(event) => setPlaceId(event.target.value)}>
                {tripPlaces.map((place) => (
                  <option key={place.id} value={place.id}>{placeLabel(place, locale)}</option>
                ))}
              </select>
            </label>
          ) : null}

          {mode === "new" ? (
            <div className="manual-pending-grid manual-pending-grid-pick">
              <label className="manual-pending-field">
                <span>{t("placeName")}</span>
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <div className="manual-pending-field">
                <span>{t("mapPoint")}</span>
                <button className="manual-pending-pick-button" type="button" onClick={() => onPickPoint(item.id, name)}>
                  <MapPin size={15} />
                  {pickedPoint ? t("reselectOnGlobe") : t("pickOnGlobe")}
                </button>
              </div>
              <div className="manual-pending-picked">
                <span>{pickedPoint ? t("nearestPlace") : t("noMapPointPicked")}</span>
                <strong>{pickedPoint ? pickedPoint.nearestLabel ?? t("noGeodataPlaceFound") : t("noMapPointPicked")}</strong>
              </div>
            </div>
          ) : null}

          {mode === "archive" ? <p className="manual-pending-note">{t("manualArchiveOnlyNote")}</p> : null}

          <div className="manual-pending-actions">
            <button type="button" onClick={onClose}>{t("cancel")}</button>
            <button type="button" onClick={submit} disabled={busy || (mode === "bind" && !placeId) || (mode === "new" && !pickedPoint)}>
              {busy ? <LoaderCircle className="animate-spin" size={15} /> : <Check size={15} />}
              {t("save")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function UploadPhotosPanel({ isClosing = false }: { isClosing?: boolean }) {
  const { locale, t } = useI18n();
  const importFiles = useAppStore((state) => state.importFiles);
  const importBatches = useAppStore((state) => state.importBatches);
  const pendingItems = useAppStore((state) => state.pendingItems);
  const trips = useAppStore((state) => state.trips);
  const photos = useAppStore((state) => state.photos);
  const placeNodes = useAppStore((state) => state.placeNodes);
  const isImporting = useAppStore((state) => state.isImporting);
  const importProgress = useAppStore((state) => state.importProgress);
  const error = useAppStore((state) => state.error);
  const confirmLatestImport = useAppStore((state) => state.confirmLatestImport);
  const rollbackLatestImport = useAppStore((state) => state.rollbackLatestImport);
  const cancelPendingImportPhotos = useAppStore((state) => state.cancelPendingImportPhotos);
  const inferPendingLocation = useAppStore((state) => state.inferPendingLocation);
  const resolveImportAiFailure = useAppStore((state) => state.resolveImportAiFailure);
  const acknowledgePendingItem = useAppStore((state) => state.acknowledgePendingItem);
  const resolvePendingManually = useAppStore((state) => state.resolvePendingManually);
  const manualPlacePick = useAppStore((state) => state.manualPlacePick);
  const openManualPlacePick = useAppStore((state) => state.openManualPlacePick);
  const closeManualPlacePick = useAppStore((state) => state.closeManualPlacePick);
  const startManualPlacePick = useAppStore((state) => state.startManualPlacePick);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inferringIds, setInferringIds] = useState<Set<string>>(() => new Set());
  const [acceptingIds, setAcceptingIds] = useState<Set<string>>(() => new Set());
  const [inferFeedback, setInferFeedback] = useState<Record<string, InferFeedback>>({});
  const [previewPhoto, setPreviewPhoto] = useState<Photo>();
  const [manualPending, setManualPending] = useState<PendingItem>();
  const [isPreviewClosing, setIsPreviewClosing] = useState(false);
  const lastBatch = importBatches[importBatches.length - 1];
  const latestBatch = lastBatch?.status === "rolled_back" ? undefined : lastBatch;
  const importedIds = useMemo(() => new Set(latestBatch?.addedPhotoIds ?? []), [latestBatch?.addedPhotoIds]);
  const importedPhotos = useMemo(() => photos.filter((photo) => importedIds.has(photo.id)), [importedIds, photos]);
  const batchPendingItems = useMemo(
    () => pendingItems.filter((item) => latestBatch?.pendingItemIds.includes(item.id) && item.status === "open"),
    [latestBatch?.pendingItemIds, pendingItems],
  );
  const progressSteps = useMemo(() => buildProgressSteps({ importProgress, isImporting, latestBatch, t }), [importProgress, isImporting, latestBatch, t]);
  const tripPreviews = useMemo(() => buildTripPreview({ batch: latestBatch, photos, placeNodes, trips, locale, t }), [latestBatch, photos, placeNodes, trips, locale, t]);
  const missingGroups = useMemo(() => groupMissingPreviews(latestBatch, photos, pendingItems, t), [latestBatch, pendingItems, photos, t]);
  const aiFailureGroups = useMemo(() => groupAiFailurePreviews(latestBatch, photos, pendingItems, t), [latestBatch, pendingItems, photos, t]);
  const canConfirm = isPendingBatch(latestBatch) && missingGroups.length === 0 && aiFailureGroups.length === 0 && !isSubmitting;
  const canRollback = isPendingBatch(latestBatch) && !isSubmitting;
  const summaryTrips = tripPreviews.length;
  const summaryPlaces = tripPreviews.reduce((count, trip) => count + trip.places.length, 0);
  const activeManualPending = manualPending ?? (manualPlacePick ? pendingItems.find((item) => item.id === manualPlacePick.pendingId) : undefined);
  const openPhotoPreview = useCallback((photo: Photo) => {
    setIsPreviewClosing(false);
    setPreviewPhoto(photo);
  }, []);
  const closePhotoPreview = useCallback(() => {
    if (!previewPhoto || isPreviewClosing) return;
    setIsPreviewClosing(true);
    window.setTimeout(() => {
      setPreviewPhoto(undefined);
      setIsPreviewClosing(false);
    }, previewExitMs);
  }, [isPreviewClosing, previewPhoto]);
  const photoPreview = previewPhoto ? (
    <div
      className="import-photo-preview"
      data-state={isPreviewClosing ? "closing" : "open"}
      role="dialog"
      aria-modal="true"
      aria-label={previewPhoto.title ?? previewPhoto.fileName}
      onClick={closePhotoPreview}
    >
      <figure onClick={(event) => event.stopPropagation()}>
        <button className="import-photo-preview-close" type="button" title={t("closePreview")} onClick={closePhotoPreview}>
          <X size={26} />
        </button>
        <img src={previewPhoto.storageUrl ?? previewPhoto.thumbnailUrl} alt={photoAltText(previewPhoto)} />
        <figcaption>
          <strong>{previewPhoto.title ?? previewPhoto.fileName}</strong>
          <span>{previewPhoto.fileName}</span>
        </figcaption>
      </figure>
    </div>
  ) : null;

  useEffect(() => {
    if (!selectedPhotoId && importedPhotos[0]) setSelectedPhotoId(importedPhotos[0].id);
  }, [importedPhotos, selectedPhotoId]);

  useEffect(() => {
    if (!previewPhoto) return;
    const closePreview = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePhotoPreview();
    };
    window.addEventListener("keydown", closePreview);
    return () => window.removeEventListener("keydown", closePreview);
  }, [closePhotoPreview, previewPhoto]);

  const startImport = (files: FileList | File[]) => {
    const nextFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (nextFiles.length > 0) void importFiles(nextFiles);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) startImport(files);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (isImporting) return;
    startImport(event.dataTransfer.files);
  };

  const acceptPending = async (item?: PendingItem) => {
    if (!item) return;
    setAcceptingIds((ids) => new Set(ids).add(item.id));
    setInferFeedback((feedback) => {
      const next = { ...feedback };
      delete next[item.id];
      return next;
    });
    try {
      await acknowledgePendingItem(item.id, true);
    } catch (error) {
      setInferFeedback((feedback) => ({
        ...feedback,
        [item.id]: { status: "error", message: error instanceof Error ? error.message : t("failed") },
      }));
    } finally {
      setAcceptingIds((ids) => {
        const next = new Set(ids);
        next.delete(item.id);
        return next;
      });
    }
  };

  const resolveManualPending = async (
    item: PendingItem,
    body: { action: "bind_existing_place"; placeId: string } | { action: "create_manual_place"; name: string; lat: number; lng: number } | { action: "archive_unlocated" },
  ) => {
    setAcceptingIds((ids) => new Set(ids).add(item.id));
    setInferFeedback((feedback) => {
      const next = { ...feedback };
      delete next[item.id];
      return next;
    });
    try {
      await resolvePendingManually(item.id, body);
      setManualPending(undefined);
      closeManualPlacePick();
    } catch (error) {
      setInferFeedback((feedback) => ({
        ...feedback,
        [item.id]: { status: "error", message: error instanceof Error ? error.message : t("failed") },
      }));
    } finally {
      setAcceptingIds((ids) => {
        const next = new Set(ids);
        next.delete(item.id);
        return next;
      });
    }
  };

  const inferPending = async (item?: PendingItem) => {
    if (!item) return;
    setInferringIds((ids) => new Set(ids).add(item.id));
    setInferFeedback((feedback) => ({
      ...feedback,
      [item.id]: { status: "running", message: t("readingContext") },
    }));
    try {
      await inferPendingLocation(item.id);
      setInferFeedback((feedback) => {
        const next = { ...feedback };
        delete next[item.id];
        return next;
      });
    } catch (error) {
      setInferFeedback((feedback) => ({
        ...feedback,
        [item.id]: { status: "error", message: error instanceof Error ? error.message : t("secondInferenceFailed") },
      }));
    } finally {
      setInferringIds((ids) => {
        const next = new Set(ids);
        next.delete(item.id);
        return next;
      });
    }
  };

  const resolveAiFailure = async (item: PendingItem | undefined, action: "retry_vision" | "retry_embedding" | "retry_both" | "archive_exif") => {
    if (!item) return;
    setAcceptingIds((ids) => new Set(ids).add(item.id));
    try {
      await resolveImportAiFailure(item.id, action);
    } catch (error) {
      setInferFeedback((feedback) => ({
        ...feedback,
        [item.id]: { status: "error", message: error instanceof Error ? error.message : t("failed") },
      }));
    } finally {
      setAcceptingIds((ids) => {
        const next = new Set(ids);
        next.delete(item.id);
        return next;
      });
    }
  };

  const confirmBatch = async () => {
    if (!canConfirm) return;
    setIsSubmitting(true);
    try {
      for (const item of batchPendingItems) {
        await acknowledgePendingItem(item.id, true);
      }
      await confirmLatestImport();
    } finally {
      setIsSubmitting(false);
    }
  };

  const rollbackBatch = async () => {
    if (!canRollback) return;
    setIsSubmitting(true);
    try {
      await rollbackLatestImport();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
    <section
      className="photo-import-panel fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12"
      data-state={isClosing ? "closing" : "open"}
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div className="mx-auto max-w-6xl">
        <div className="photo-import-heading mb-7 flex items-start justify-between gap-6">
          <div>
            <h2 className="font-serif text-4xl font-semibold leading-tight text-primary md:text-6xl">{t("archivePreview")}</h2>
          </div>
        </div>

        <input ref={inputRef} className="sr-only" type="file" accept="image/*" multiple onChange={handleFileChange} />

        <div className="import-intake" data-dragging={isDragging || undefined}>
          <button className="import-pick-button" type="button" onClick={() => inputRef.current?.click()} disabled={isImporting} title={t("choosePhotos")}>
            {isImporting ? <LoaderCircle className="animate-spin" size={18} /> : <FolderOpen size={18} />}
            <span>{isImporting ? t("importing") : t("choosePhotos")}</span>
          </button>

          <div className="import-progress-stack" aria-label={t("importing")}>
            {progressSteps.map((step) => (
              <ProgressLine key={step.label} step={step} />
            ))}
          </div>

          {error ? <p className="photo-import-error">{error}</p> : null}
        </div>

        <div className="import-review-shell">
          {tripPreviews.length ? (
            <ReviewTree
              previews={tripPreviews}
            selectedPhotoId={selectedPhotoId}
            onOpenPreview={openPhotoPreview}
            onRemovePhoto={isPendingBatch(latestBatch) ? (photoId) => void cancelPendingImportPhotos([photoId]) : undefined}
            onSelectPhoto={setSelectedPhotoId}
            t={t}
          />
          ) : (
            <div className="import-empty-stage">
              <ImagePlus size={26} />
              <span>+</span>
            </div>
          )}

          <MissingSuggestions
            groups={missingGroups}
            inferFeedback={inferFeedback}
            inferringIds={inferringIds}
            acceptingIds={acceptingIds}
            selectedPhotoId={selectedPhotoId}
            onAccept={(item) => void acceptPending(item)}
            onInfer={(item) => void inferPending(item)}
            onManual={(item) => {
              setManualPending(item);
              if (item) openManualPlacePick(item.id, photos.find((photo) => item.relatedPhotoIds.includes(photo.id))?.title ?? photos.find((photo) => item.relatedPhotoIds.includes(photo.id))?.fileName ?? "");
            }}
            onOpenPreview={openPhotoPreview}
            onReject={(photoIds) => void cancelPendingImportPhotos(photoIds)}
            onSelectPhoto={setSelectedPhotoId}
            t={t}
          />

          <AiFailureSuggestions
            failures={aiFailureGroups}
            acceptingIds={acceptingIds}
            selectedPhotoId={selectedPhotoId}
            onManual={(item) => {
              setManualPending(item);
              if (item) openManualPlacePick(item.id, photos.find((photo) => item.relatedPhotoIds.includes(photo.id))?.title ?? photos.find((photo) => item.relatedPhotoIds.includes(photo.id))?.fileName ?? "");
            }}
            onOpenPreview={openPhotoPreview}
            onReject={(photoIds) => void cancelPendingImportPhotos(photoIds)}
            onResolve={(item, action) => void resolveAiFailure(item, action)}
            onSelectPhoto={setSelectedPhotoId}
            t={t}
          />

          {(latestBatch || isImporting) ? (
            <footer className="import-command-bar">
              <div className="import-command-stats">
                <span title={t("newPhotos")}><FileImage size={15} />{t("newPhotos")} {latestBatch?.addedPhotoIds.length ?? importProgress?.total ?? 0}</span>
                {(latestBatch?.duplicateCount ?? 0) > 0 ? <span title={t("duplicateSkipped")}>{t("duplicateSkipped")} {latestBatch?.duplicateCount}</span> : null}
                <span title={t("trips")}><Circle size={13} />{t("trips")} {summaryTrips}</span>
                <span title={t("places")}><MapPin size={15} />{t("places")} {summaryPlaces}</span>
                <span title={t("pending")}>{t("pending")} {batchPendingItems.length}</span>
              </div>
              <div className="import-command-actions">
                <button className="import-undo-button" onClick={() => void rollbackBatch()} disabled={!canRollback} type="button" title={t("rollbackImport")} aria-label={t("rollbackImport")}>
                  <RotateCcw size={17} />
                </button>
                <button className="import-confirm-button" onClick={() => void confirmBatch()} disabled={!canConfirm} type="button">
                  {isSubmitting ? <LoaderCircle className="animate-spin" size={15} /> : null}
                  {t("confirm")}
                </button>
              </div>
            </footer>
          ) : null}
        </div>
      </div>
    </section>
    {photoPreview ? createPortal(photoPreview, document.body) : null}
    {activeManualPending ? createPortal(
      <ManualPendingResolutionModal
        item={activeManualPending}
        locale={locale}
        photos={photos}
        places={placeNodes}
        busy={acceptingIds.has(activeManualPending.id)}
        initialName={manualPlacePick?.pendingId === activeManualPending.id ? manualPlacePick.name : undefined}
        initialMode={manualPlacePick?.pendingId === activeManualPending.id ? manualPlacePick.mode : undefined}
        pickedPoint={
          manualPlacePick?.pendingId === activeManualPending.id && manualPlacePick.point
            ? { ...manualPlacePick.point, nearestLabel: manualPlacePick.nearestLabel }
            : undefined
        }
        onClose={() => {
          setManualPending(undefined);
          closeManualPlacePick();
        }}
        onPickPoint={(pendingId, name) => startManualPlacePick(pendingId, name)}
        onSubmit={(body) => void resolveManualPending(activeManualPending, body)}
        t={t}
      />,
      document.body,
    ) : null}
    </>
  );
}
