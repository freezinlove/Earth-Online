import { Check, Circle, Clock3, FileImage, FolderOpen, ImagePlus, LoaderCircle, MapPin, PencilLine, RotateCcw, Sparkles, X, type LucideIcon } from "lucide-react";
import type { CSSProperties, ChangeEvent, DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { capturedDateLabel } from "@/domain/datetime";
import { photoAltText, placeLabel, tripLabel } from "@/domain/labels";
import { photoDisplaySource } from "@/domain/photoSources";
import { useI18n } from "@/i18n/useI18n";
import type { MessageKey } from "@/i18n/messages";
import type { ImportBatch, PendingItem, Photo, PlaceNode, Trip } from "@/domain/models";
import type { ImportJobProgress } from "@/services/apiClient";
import { ManualPlaceResolutionModal, type ManualPlaceResolutionAction } from "@/features/places/ManualPlaceResolutionModal";
import { isAndroidRuntime } from "@/platform";
import { pickNativePhotoAssets } from "@/platform/nativePhotoLibrary";
import { useAppStore } from "@/store/appStore";

type ImportStep = {
  icon?: LucideIcon;
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

type BulkAiFailureAction = "retry_vision" | "retry_embedding";

const previewExitMs = 180;

function unplacedPreviewKey(tripId: string, photos: Photo[]) {
  return `unplaced:${tripId}:${photos.map((photo) => photo.id).sort().join(",")}`;
}

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

function targetTextDensity(label: string) {
  const length = Array.from(label.trim()).length;
  if (length > 16) return "dense";
  if (length > 8) return "compact";
  return "normal";
}

function tripTitleTextDensity(label: string) {
  const length = Array.from(label.trim()).length;
  if (length > 42) return "dense";
  if (length > 26) return "compact";
  return "normal";
}

function hasActionableMissingProposal(item?: PendingItem) {
  return Boolean(item?.proposal && item.proposal.action !== "keep_pending");
}

function missingPreviewTime(group: MissingPreview) {
  return group.photos
    .map((photo) => photo.capturedAt)
    .filter(Boolean)
    .sort()[0];
}

function compareMissingPreviews(left: MissingPreview, right: MissingPreview) {
  const leftActionable = hasActionableMissingProposal(left.pending);
  const rightActionable = hasActionableMissingProposal(right.pending);
  if (leftActionable !== rightActionable) return leftActionable ? -1 : 1;

  const leftTime = missingPreviewTime(left) ?? "9999-12-31T23:59:59.999Z";
  const rightTime = missingPreviewTime(right) ?? "9999-12-31T23:59:59.999Z";
  const timeOrder = leftTime.localeCompare(rightTime);
  if (timeOrder !== 0) return timeOrder;

  return left.id.localeCompare(right.id);
}

function sortMissingPreviews(groups: MissingPreview[]) {
  return [...groups].sort(compareMissingPreviews);
}

function orderMissingPreviews(groups: MissingPreview[], lockedOrderIds?: string[]) {
  if (!lockedOrderIds?.length) return sortMissingPreviews(groups);
  const order = new Map(lockedOrderIds.map((id, index) => [id, index]));
  return [...groups].sort((left, right) => {
    const leftOrder = order.get(left.id);
    const rightOrder = order.get(right.id);
    if (leftOrder !== undefined || rightOrder !== undefined) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
    return compareMissingPreviews(left, right);
  });
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
    const displayPhase = uploadDone >= total && exifDone >= total && thumbnailDone >= total && aiDone >= total && embeddingDone >= total ? "grouping" : phase;

    return [
      { icon: FileImage, label: t("uploadPhotos"), done: Math.min(uploadDone, total), total, active: displayPhase === "reading" || displayPhase === "uploading" },
      { icon: Clock3, label: t("parseExif"), done: Math.min(exifDone, total), total, active: displayPhase === "exif" },
      { icon: ImagePlus, label: t("generateThumbnails"), done: Math.min(thumbnailDone, total), total, active: displayPhase === "thumbnails" },
      { icon: Sparkles, label: t("aiImageUnderstanding"), done: Math.min(aiDone, total), total, active: displayPhase === "ai" },
      { icon: Circle, label: t("generateVectors"), done: Math.min(embeddingDone, total), total, active: displayPhase === "embedding" },
    ];
  }

  return [];
}

function isImportMainProgressComplete(progress?: ImportJobProgress) {
  const total = Math.max(
    progress?.total ?? 0,
    progress?.steps?.reading?.total ?? 0,
    progress?.steps?.upload?.total ?? 0,
    progress?.steps?.exif?.total ?? 0,
    progress?.steps?.thumbnails?.total ?? 0,
    progress?.steps?.ai?.total ?? 0,
    progress?.steps?.embedding?.total ?? 0,
  );
  if (!progress || total <= 0) return false;
  const done = (key: "reading" | "upload" | "exif" | "thumbnails" | "ai" | "embedding") => progress.steps?.[key]?.done ?? 0;
  const uploadDone = Math.max(done("reading"), done("upload"));
  return uploadDone >= total && done("exif") >= total && done("thumbnails") >= total && done("ai") >= total && done("embedding") >= total;
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
        })
        .filter((place) => place.photos.length > 0);
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
        label: gps ? t("noRealExifGps") : t("hasRealExifGps"),
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
    .map((photo) => {
      const hasRealExifGps = Boolean(photo.aiFailure?.hasRealExifGps || photo.exifStatus?.gps === "read");
      return {
        id: photo.id,
        label: hasRealExifGps ? t("hasRealExifGps") : t("noRealExifGps"),
        error: aiFailureError(photo) || pendingByPhoto.get(photo.id)?.reason || t("failed"),
        hasRealExifGps,
        photo,
        pending: pendingByPhoto.get(photo.id),
      };
    });
}

function PhotoStrip({
  photos,
  draggable,
  draggingPhotoId,
  onDragEnd,
  onDragStart,
  onRemovePhoto,
  selectedPhotoId,
  onOpenPreview,
  onSelect,
  t,
}: {
  photos: Photo[];
  draggable?: boolean;
  draggingPhotoId?: string;
  onDragEnd?: () => void;
  onDragStart?: (photo: Photo, event: DragEvent<HTMLSpanElement>) => void;
  onRemovePhoto?: (photoId: string) => void;
  selectedPhotoId?: string;
  onOpenPreview?: (photo: Photo) => void;
  onSelect: (photoId: string) => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <div className="import-photo-strip">
      {photos.map((photo) => (
        <span
          key={photo.id}
          className="import-thumb-shell"
          data-active={selectedPhotoId === photo.id || undefined}
          data-dragging={draggingPhotoId === photo.id || undefined}
          draggable={draggable}
          onDragEnd={onDragEnd}
          onDragStart={(event) => onDragStart?.(photo, event)}
        >
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

function ProgressLine({ step, showIcon = true }: { step: ImportStep; showIcon?: boolean }) {
  const Icon = step.icon;
  const hasMeter = typeof step.done === "number" && typeof step.total === "number";
  const total = Math.max(1, step.total ?? 1);
  const width = hasMeter ? Math.max(step.done && step.done > 0 ? 8 : 0, Math.min(100, ((step.done ?? 0) / total) * 100)) : 0;
  const progressStyle = { width: `${width}%`, "--progress-ratio": width / 100 } as CSSProperties;

  return (
    <div className="import-progress-line" data-active={step.active || undefined} data-no-icon={!showIcon || !Icon || undefined} title={step.label}>
      {showIcon && Icon ? <Icon size={15} /> : null}
      <span className="import-progress-label">{step.label}</span>
      <span className="import-progress-track">
        <span style={progressStyle} />
      </span>
      <strong>{hasMeter ? `${step.done}/${step.total}` : ""}</strong>
    </div>
  );
}

function ReviewTree({
  previews,
  selectedPhotoId,
  canEdit,
  onOpenPreview,
  onMovePhoto,
  onRenamePlace,
  onRenameTrip,
  onRemovePhoto,
  onSelectPhoto,
  t,
}: {
  previews: TripPreview[];
  selectedPhotoId?: string;
  canEdit: boolean;
  onOpenPreview: (photo: Photo) => void;
  onMovePhoto: (photoId: string, placeId: string) => Promise<void>;
  onRenamePlace: (placeId: string, name: string) => Promise<void>;
  onRenameTrip: (tripId: string, title: string) => Promise<void>;
  onRemovePhoto?: (photoId: string) => void;
  onSelectPhoto: (photoId: string) => void;
  t: (key: MessageKey) => string;
}) {
  const [editingTripId, setEditingTripId] = useState<string>();
  const [tripTitleDraft, setTripTitleDraft] = useState("");
  const [editingPlaceId, setEditingPlaceId] = useState<string>();
  const [editingUnplacedKey, setEditingUnplacedKey] = useState<string>();
  const [placeNameDraft, setPlaceNameDraft] = useState("");
  const [unplacedLabels, setUnplacedLabels] = useState<Record<string, string>>({});
  const [draggingPhotoId, setDraggingPhotoId] = useState<string>();
  const [droppingPlaceId, setDroppingPlaceId] = useState<string>();
  const dragPreviewRef = useRef<HTMLElement | null>(null);

  const visibleTripIds = useMemo(() => new Set(previews.map((preview) => preview.trip.id)), [previews]);
  const visiblePlaceIds = useMemo(
    () => new Set(previews.flatMap((preview) => preview.places.map((place) => place.place?.id).filter((id): id is string => Boolean(id)))),
    [previews],
  );
  const visiblePhotoIds = useMemo(
    () => new Set(previews.flatMap((preview) => preview.places.flatMap((place) => place.photos.map((photo) => photo.id)))),
    [previews],
  );
  const visibleUnplacedKeys = useMemo(
    () => new Set(previews.flatMap((preview) => preview.places.filter((place) => !place.place).map((place) => unplacedPreviewKey(preview.trip.id, place.photos)))),
    [previews],
  );

  const clearDragPreview = useCallback(() => {
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
  }, []);

  useEffect(() => {
    if (editingTripId && !visibleTripIds.has(editingTripId)) {
      setEditingTripId(undefined);
      setTripTitleDraft("");
    }
    if (editingPlaceId && !visiblePlaceIds.has(editingPlaceId)) {
      setEditingPlaceId(undefined);
      setPlaceNameDraft("");
    }
    if (editingUnplacedKey && !visibleUnplacedKeys.has(editingUnplacedKey)) {
      setEditingUnplacedKey(undefined);
      setPlaceNameDraft("");
    }
    if (droppingPlaceId && !visiblePlaceIds.has(droppingPlaceId)) setDroppingPlaceId(undefined);
    if (draggingPhotoId && !visiblePhotoIds.has(draggingPhotoId)) {
      setDraggingPhotoId(undefined);
      clearDragPreview();
    }
    setUnplacedLabels((labels) => {
      const next = Object.fromEntries(Object.entries(labels).filter(([key]) => visibleUnplacedKeys.has(key)));
      return Object.keys(next).length === Object.keys(labels).length ? labels : next;
    });
  }, [clearDragPreview, draggingPhotoId, droppingPlaceId, editingPlaceId, editingTripId, editingUnplacedKey, visiblePhotoIds, visiblePlaceIds, visibleTripIds, visibleUnplacedKeys]);

  if (!previews.length) return null;

  const setPhotoDragPreview = (event: DragEvent<HTMLSpanElement>) => {
    clearDragPreview();
    const preview = event.currentTarget.cloneNode(true) as HTMLElement;
    preview.className = "import-thumb-shell import-thumb-drag-image";
    preview.removeAttribute("data-active");
    preview.removeAttribute("data-dragging");
    preview.querySelector(".import-thumb-remove")?.remove();
    document.body.appendChild(preview);
    dragPreviewRef.current = preview;
    event.dataTransfer.setDragImage(preview, preview.offsetWidth / 2, preview.offsetHeight / 2);
  };

  const submitPlaceName = async (place?: PlaceNode, currentLabel = "") => {
    const name = placeNameDraft.trim();
    setEditingPlaceId(undefined);
    setPlaceNameDraft("");
    if (!place || !name || name === currentLabel) return;
    await onRenamePlace(place.id, name);
  };

  const submitUnplacedName = (key: string, currentLabel: string) => {
    const name = placeNameDraft.trim();
    setEditingUnplacedKey(undefined);
    setPlaceNameDraft("");
    setUnplacedLabels((labels) => {
      const next = { ...labels };
      if (!name || name === currentLabel) {
        delete next[key];
      } else {
        next[key] = name;
      }
      return next;
    });
  };

  const submitTripTitle = async (trip?: Trip) => {
    const title = tripTitleDraft.trim();
    setEditingTripId(undefined);
    setTripTitleDraft("");
    if (!trip || !title || title === tripLabel(trip)) return;
    await onRenameTrip(trip.id, title);
  };

  return (
    <section className="import-review-tree" aria-label={t("archiveTree")}>
      {previews.map((preview) => {
        const title = tripLabel(preview.trip);
        return (
        <div key={preview.trip.id} className="import-trip-node" data-new={preview.isNew || undefined}>
          <div className="import-node-label import-node-label-trip" data-density={tripTitleTextDensity(title)}>
            {preview.isNew ? <Circle size={12} /> : <span className="import-solid-dot" />}
            {editingTripId === preview.trip.id ? (
              <input
                className="import-trip-title-input"
                autoFocus
                value={tripTitleDraft}
                onBlur={() => void submitTripTitle(preview.trip)}
                onChange={(event) => setTripTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setEditingTripId(undefined);
                    setTripTitleDraft("");
                  }
                }}
              />
            ) : (
              <span className="import-trip-title-text">{title}</span>
            )}
            {canEdit ? (
              <button
                className="import-trip-rename"
                type="button"
                aria-label={t("edit")}
                title={t("edit")}
                onClick={() => {
                  setEditingTripId(preview.trip.id);
                  setTripTitleDraft(title);
                }}
              >
                <PencilLine size={13} />
              </button>
            ) : null}
            <em>{preview.isNew ? t("newTrip") : t("existingTrip")}</em>
          </div>
          <div className="import-place-branch">
            {preview.places.map((placePreview) => {
              const placeId = placePreview.place?.id;
              const placeKey = placeId ?? unplacedPreviewKey(preview.trip.id, placePreview.photos);
              const label = placeId ? placePreview.label : unplacedLabels[placeKey] ?? placePreview.label;
              const isEditingPlace = Boolean(placeId && editingPlaceId === placeId);
              const isEditingUnplaced = !placeId && editingUnplacedKey === placeKey;
              return (
                <div
                  key={placeKey}
                  className="import-place-node"
                  data-new={placePreview.isNew || undefined}
                  data-drop-target={(placeId && droppingPlaceId === placeId) || undefined}
                  onDragEnter={(event) => {
                    if (!canEdit || !placeId || !draggingPhotoId || placePreview.photos.some((photo) => photo.id === draggingPhotoId)) return;
                    event.preventDefault();
                    setDroppingPlaceId(placeId);
                  }}
                  onDragOver={(event) => {
                    if (!canEdit || !placeId || !draggingPhotoId || placePreview.photos.some((photo) => photo.id === draggingPhotoId)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                    if (placeId) setDroppingPlaceId((current) => (current === placeId ? undefined : current));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const photoId = event.dataTransfer.getData("application/x-earth-online-photo-id") || draggingPhotoId;
                    setDroppingPlaceId(undefined);
                    setDraggingPhotoId(undefined);
                    if (!canEdit || !placeId || !photoId || placePreview.photos.some((photo) => photo.id === photoId)) return;
                    void onMovePhoto(photoId, placeId);
                  }}
                >
                  <div className="import-node-label">
                    {placePreview.isNew ? <Circle size={10} /> : <span className="import-solid-dot import-solid-dot-small" />}
                    <MapPin size={14} />
                    {isEditingPlace || isEditingUnplaced ? (
                      <input
                        className="import-place-name-input"
                        autoFocus
                        value={placeNameDraft}
                        onBlur={() => {
                          if (isEditingPlace) void submitPlaceName(placePreview.place, label);
                          if (isEditingUnplaced) submitUnplacedName(placeKey, placePreview.label);
                        }}
                        onChange={(event) => setPlaceNameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                          if (event.key === "Escape") {
                            setEditingPlaceId(undefined);
                            setEditingUnplacedKey(undefined);
                            setPlaceNameDraft("");
                          }
                        }}
                      />
                    ) : (
                      <span>{label}</span>
                    )}
                    {canEdit && (placePreview.place || placePreview.photos.length > 0) ? (
                      <button
                        className="import-place-rename"
                        type="button"
                        aria-label={t("editPlaceName")}
                        title={t("editPlaceName")}
                        onClick={() => {
                          if (placePreview.place) {
                            setEditingPlaceId(placeId);
                            setPlaceNameDraft(label);
                            return;
                          }
                          setEditingUnplacedKey(placeKey);
                          setPlaceNameDraft(label);
                        }}
                      >
                        <PencilLine size={12} />
                      </button>
                    ) : null}
                    <em>{placePreview.isNew ? t("newPlace") : t("merge")}</em>
                    <time>{placePreview.timeLabel}</time>
                  </div>
                  <PhotoStrip
                    photos={placePreview.photos}
                    draggable={canEdit}
                    draggingPhotoId={draggingPhotoId}
                    selectedPhotoId={selectedPhotoId}
                    onDragEnd={() => {
                      setDraggingPhotoId(undefined);
                      setDroppingPlaceId(undefined);
                      clearDragPreview();
                    }}
                    onDragStart={(photo, event) => {
                      setDraggingPhotoId(photo.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-earth-online-photo-id", photo.id);
                      event.dataTransfer.setData("text/plain", photo.fileName);
                      setPhotoDragPreview(event);
                    }}
                    onOpenPreview={onOpenPreview}
                    onRemovePhoto={onRemovePhoto}
                    onSelect={onSelectPhoto}
                    t={t}
                  />
                </div>
              );
            })}
          </div>
        </div>
        );
      })}
    </section>
  );
}

function MissingSuggestions({
  groups,
  bulkProgress,
  inferFeedback,
  inferringIds,
  isBulkInferring,
  readOnly,
  acceptingIds,
  selectedPhotoId,
  onAccept,
  onInferAll,
  onInfer,
  onManual,
  onOpenPreview,
  onReject,
  onSelectPhoto,
  t,
}: {
  groups: MissingPreview[];
  bulkProgress?: ImportJobProgress;
  inferFeedback: Record<string, InferFeedback>;
  inferringIds: Set<string>;
  isBulkInferring: boolean;
  readOnly: boolean;
  acceptingIds: Set<string>;
  selectedPhotoId?: string;
  onAccept: (item?: PendingItem) => void;
  onInferAll: (items: PendingItem[]) => void;
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
  const bulkTotal = bulkProgress?.steps?.ai?.total ?? bulkProgress?.total ?? inferableItems.length;
  const bulkDone = bulkProgress?.steps?.ai?.done ?? bulkProgress?.done ?? 0;
  const bulkStep: ImportStep = {
    icon: Sparkles,
    label: t("aiSecondInference"),
    done: isBulkInferring ? bulkDone : 0,
    total: Math.max(bulkTotal, inferableItems.length, 1),
    active: isBulkInferring,
  };

  return (
    <section className="import-missing" aria-label={t("pendingSuggestions")}>
      <div className="import-missing-heading">
        <span>{t("pendingInfo")}</span>
        <small>{groups.reduce((count, group) => count + group.photos.length, 0)} {t("photoCount")}</small>
      </div>
      <div className="import-missing-bulk">
        <div className="import-missing-heading-actions">
          <button onClick={() => onReject(allPhotoIds)} disabled={readOnly || !allPhotoIds.length || isBulkInferring} aria-label={t("cancelImport")} type="button" data-tooltip={t("cancelImport")}>
            <X size={14} />
          </button>
          <button
            onClick={() => onInferAll(inferableItems.filter((item) => !inferringIds.has(item.id)))}
            disabled={readOnly || !hasInferable || isBulkInferring}
            aria-label={t("aiSecondInference")}
            type="button"
            data-tooltip={t("aiSecondInference")}
          >
            {isBulkInferring ? <LoaderCircle className="animate-spin" size={14} /> : <Sparkles size={14} />}
          </button>
        </div>
        <div className="import-progress-stack import-progress-stack-inline" aria-label={t("aiSecondInference")}>
          <ProgressLine step={bulkStep} showIcon={false} />
        </div>
      </div>
      <div className="import-missing-list">
        {groups.map((group) => {
          const isInferring = Boolean(group.pending && inferringIds.has(group.pending.id));
          const isAccepting = Boolean(group.pending && acceptingIds.has(group.pending.id));
          const isRowLocked = readOnly || isBulkInferring || isInferring || isAccepting;
          const actionable = hasActionableMissingProposal(group.pending);
          const suggestedTarget = pendingProposalTarget(group.pending, group.target);
          const feedback = group.pending ? inferFeedback[group.pending.id] : undefined;
          const statusLabel = actionable ? t("suggestionShort") : t("undecided");
          const statusState = actionable ? "suggestion" : "pending";
          const targetDensity = targetTextDensity(suggestedTarget.label);
          return (
            <div key={group.id} className="import-missing-row" title={group.pending?.reason ?? group.label}>
              <PhotoStrip photos={group.photos} selectedPhotoId={selectedPhotoId} onOpenPreview={onOpenPreview} onSelect={onSelectPhoto} t={t} />
              <span className="import-missing-field">{group.label}</span>
              <span className="import-ai-suggest" data-state={statusState}>{statusLabel}</span>
              <strong className="import-missing-target" data-density={targetDensity}>
                <span>{suggestedTarget.label}</span>
              </strong>
              <button className="import-inline-cancel" onClick={() => onReject(group.photos.map((photo) => photo.id))} disabled={isRowLocked} aria-label={t("cancelImport")} type="button" data-tooltip={t("cancelImport")}>
                <X size={13} />
              </button>
              <button className="import-inline-infer" onClick={() => onInfer(group.pending)} disabled={!group.pending || isRowLocked} aria-label={t("aiSecondInference")} type="button" data-tooltip={t("aiSecondInference")}>
                {isInferring ? <LoaderCircle className="animate-spin" size={13} /> : <Sparkles size={13} />}
              </button>
              <button className="import-inline-manual" onClick={() => onManual(group.pending)} disabled={!group.pending || isRowLocked} aria-label={t("manualResolve")} type="button" data-tooltip={t("manualResolve")}>
                <PencilLine size={13} />
              </button>
              {actionable ? (
                <button className="import-inline-confirm" onClick={() => onAccept(group.pending)} disabled={isRowLocked} aria-label={t("confirmSuggestion")} type="button" data-tooltip={t("confirmSuggestion")}>
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
  bulkProgress,
  acceptingIds,
  isBulkResolving,
  readOnly,
  selectedPhotoId,
  onManual,
  onOpenPreview,
  onReject,
  bulkAction,
  onResolveAllEmbedding,
  onResolveAllVision,
  onResolve,
  onSelectPhoto,
  t,
}: {
  failures: AiFailurePreview[];
  bulkProgress?: ImportJobProgress;
  acceptingIds: Set<string>;
  isBulkResolving: boolean;
  readOnly: boolean;
  selectedPhotoId?: string;
  onManual: (item?: PendingItem) => void;
  onOpenPreview: (photo: Photo) => void;
  onReject: (photoIds: string[]) => void;
  bulkAction?: BulkAiFailureAction;
  onResolveAllEmbedding: (items: PendingItem[]) => void;
  onResolveAllVision: (items: PendingItem[]) => void;
  onResolve: (item: PendingItem | undefined, action: "retry_vision" | "retry_embedding" | "retry_both" | "archive_exif") => void;
  onSelectPhoto: (photoId: string) => void;
  t: (key: MessageKey) => string;
}) {
  if (!failures.length) return null;
  const allPhotoIds = failures.map((failure) => failure.photo.id);
  const retryableVisionItems = Array.from(
    new Map(
      failures
        .filter((failure) => failure.photo.aiFailure?.vision)
        .map((failure) => failure.pending)
        .filter((item): item is PendingItem => Boolean(item))
        .map((item) => [item.id, item]),
    ).values(),
  );
  const retryableEmbeddingItems = Array.from(
    new Map(
      failures
        .filter((failure) => failure.photo.aiFailure?.embedding)
        .map((failure) => failure.pending)
        .filter((item): item is PendingItem => Boolean(item))
        .map((item) => [item.id, item]),
    ).values(),
  );
  const activeRetryableItems = bulkAction === "retry_embedding" ? retryableEmbeddingItems : retryableVisionItems;
  const bulkLabel = bulkAction === "retry_embedding" ? t("retryEmbedding") : t("retryAiVision");
  const bulkIcon = bulkAction === "retry_embedding" ? Circle : Sparkles;
  const bulkTotal = bulkProgress?.steps?.ai?.total ?? bulkProgress?.total ?? activeRetryableItems.length;
  const bulkDone = bulkProgress?.steps?.ai?.done ?? bulkProgress?.done ?? 0;
  const bulkStep: ImportStep = {
    icon: bulkIcon,
    label: bulkLabel,
    done: isBulkResolving ? bulkDone : 0,
    total: Math.max(bulkTotal, activeRetryableItems.length, 1),
    active: isBulkResolving,
  };

  return (
    <section className="import-missing import-ai-failures" aria-label={t("aiProcessingFailures")}>
      <div className="import-missing-heading">
        <span>{t("aiProcessingFailures")}</span>
        <small>{failures.length} {t("photoCount")}</small>
      </div>
      <div className="import-missing-bulk">
        <div className="import-missing-heading-actions">
          <button onClick={() => onReject(allPhotoIds)} disabled={readOnly || !allPhotoIds.length || isBulkResolving} aria-label={t("cancelImport")} type="button" data-tooltip={t("cancelImport")}>
            <X size={14} />
          </button>
          <button
            onClick={() => onResolveAllVision(retryableVisionItems)}
            disabled={readOnly || !retryableVisionItems.length || isBulkResolving}
            aria-label={t("retryAiVision")}
            type="button"
            data-tooltip={t("retryAiVision")}
          >
            {isBulkResolving && bulkAction === "retry_vision" ? <LoaderCircle className="animate-spin" size={14} /> : <Sparkles size={14} />}
          </button>
          <button
            onClick={() => onResolveAllEmbedding(retryableEmbeddingItems)}
            disabled={readOnly || !retryableEmbeddingItems.length || isBulkResolving}
            aria-label={t("retryEmbedding")}
            type="button"
            data-tooltip={t("retryEmbedding")}
          >
            {isBulkResolving && bulkAction === "retry_embedding" ? <LoaderCircle className="animate-spin" size={14} /> : <Circle size={14} />}
          </button>
        </div>
        <div className="import-progress-stack import-progress-stack-inline" aria-label={bulkLabel}>
          <ProgressLine step={bulkStep} showIcon={false} />
        </div>
      </div>
      <div className="import-missing-list">
        {failures.map((failure) => {
          const isBusy = Boolean(failure.pending && acceptingIds.has(failure.pending.id));
          const isRowLocked = readOnly || isBulkResolving || isBusy;
          const canRetryVision = Boolean(failure.photo.aiFailure?.vision);
          const canRetryEmbedding = Boolean(failure.photo.aiFailure?.embedding);
          const targetLabel = failure.photo.title ?? failure.photo.fileName;
          return (
            <div key={failure.id} className="import-missing-row import-ai-failure-row" title={failure.error}>
              <PhotoStrip photos={[failure.photo]} selectedPhotoId={selectedPhotoId} onOpenPreview={onOpenPreview} onSelect={onSelectPhoto} t={t} />
              <span className="import-missing-field">{failure.label}</span>
              <span className="import-ai-suggest" data-state="pending">{t("undecided")}</span>
              <strong className="import-missing-target" data-density={targetTextDensity(targetLabel)}>
                <span>{targetLabel}</span>
              </strong>
              <button className="import-inline-cancel" onClick={() => onReject([failure.photo.id])} disabled={isRowLocked} aria-label={t("cancelImport")} type="button" data-tooltip={t("cancelImport")}>
                <X size={13} />
              </button>
              {canRetryVision && canRetryEmbedding ? (
                <button className="import-inline-infer" onClick={() => onResolve(failure.pending, "retry_both")} disabled={!failure.pending || isRowLocked} aria-label={t("retryBothAi")} type="button" data-tooltip={t("retryBothAi")}>
                  {isBusy ? <LoaderCircle className="animate-spin" size={13} /> : <Sparkles size={13} />}
                </button>
              ) : null}
              {canRetryVision && !canRetryEmbedding ? (
                <button className="import-inline-infer" onClick={() => onResolve(failure.pending, "retry_vision")} disabled={!failure.pending || isRowLocked} aria-label={t("retryAiVision")} type="button" data-tooltip={t("retryAiVision")}>
                  {isBusy ? <LoaderCircle className="animate-spin" size={13} /> : <Sparkles size={13} />}
                </button>
              ) : null}
              {canRetryEmbedding && !canRetryVision ? (
                <button className="import-inline-infer" onClick={() => onResolve(failure.pending, "retry_embedding")} disabled={!failure.pending || isRowLocked} aria-label={t("retryEmbedding")} type="button" data-tooltip={t("retryEmbedding")}>
                  {isBusy ? <LoaderCircle className="animate-spin" size={13} /> : <Circle size={13} />}
                </button>
              ) : null}
              {failure.hasRealExifGps ? (
                <button className="import-inline-confirm" onClick={() => onResolve(failure.pending, "archive_exif")} disabled={!failure.pending || isRowLocked} aria-label={t("archiveByExif")} type="button" data-tooltip={t("archiveByExif")}>
                  <MapPin size={14} />
                </button>
              ) : null}
              <button className="import-inline-manual" onClick={() => onManual(failure.pending)} disabled={!failure.pending || isRowLocked} aria-label={t("manualResolve")} type="button" data-tooltip={t("manualResolve")}>
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

export function UploadPhotosPanel({ isClosing = false }: { isClosing?: boolean }) {
  const { locale, t } = useI18n();
  const importFiles = useAppStore((state) => state.importFiles);
  const importMobilePhotoAssets = useAppStore((state) => state.importMobilePhotoAssets);
  const importBatches = useAppStore((state) => state.importBatches);
  const pendingItems = useAppStore((state) => state.pendingItems);
  const trips = useAppStore((state) => state.trips);
  const photos = useAppStore((state) => state.photos);
  const placeNodes = useAppStore((state) => state.placeNodes);
  const isImporting = useAppStore((state) => state.isImporting);
  const isImportReadOnly = useAppStore((state) => state.isImportReadOnly);
  const importProgress = useAppStore((state) => state.importProgress);
  const error = useAppStore((state) => state.error);
  const confirmLatestImport = useAppStore((state) => state.confirmLatestImport);
  const rollbackLatestImport = useAppStore((state) => state.rollbackLatestImport);
  const cancelPendingImportPhotos = useAppStore((state) => state.cancelPendingImportPhotos);
  const bindPhotoToPlace = useAppStore((state) => state.bindPhotoToPlace);
  const updateTripTitle = useAppStore((state) => state.updateTripTitle);
  const updatePlaceName = useAppStore((state) => state.updatePlaceName);
  const inferPendingLocation = useAppStore((state) => state.inferPendingLocation);
  const inferPendingLocations = useAppStore((state) => state.inferPendingLocations);
  const resolveImportAiFailure = useAppStore((state) => state.resolveImportAiFailure);
  const resolveImportAiFailures = useAppStore((state) => state.resolveImportAiFailures);
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
  const [bulkInferProgress, setBulkInferProgress] = useState<ImportJobProgress>();
  const [isBulkInferring, setIsBulkInferring] = useState(false);
  const [bulkAiFailureProgress, setBulkAiFailureProgress] = useState<ImportJobProgress>();
  const [bulkAiFailureAction, setBulkAiFailureAction] = useState<BulkAiFailureAction>();
  const [isBulkResolvingAiFailures, setIsBulkResolvingAiFailures] = useState(false);
  const [lockedMissingOrderIds, setLockedMissingOrderIds] = useState<string[]>();
  const [previewPhoto, setPreviewPhoto] = useState<Photo>();
  const [manualPending, setManualPending] = useState<PendingItem>();
  const [isPreviewClosing, setIsPreviewClosing] = useState(false);
  const nativePickerOpenRef = useRef(false);
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
  const showOrganizingNotice = isImporting && !latestBatch && isImportMainProgressComplete(importProgress);
  const rawMissingGroups = useMemo(() => groupMissingPreviews(latestBatch, photos, pendingItems, t), [latestBatch, pendingItems, photos, t]);
  const missingGroups = useMemo(() => orderMissingPreviews(rawMissingGroups, lockedMissingOrderIds), [lockedMissingOrderIds, rawMissingGroups]);
  const aiFailureGroups = useMemo(() => groupAiFailurePreviews(latestBatch, photos, pendingItems, t), [latestBatch, pendingItems, photos, t]);
  const canConfirm = isPendingBatch(latestBatch) && missingGroups.length === 0 && aiFailureGroups.length === 0 && !isSubmitting && !isImportReadOnly;
  const canRollback = isPendingBatch(latestBatch) && !isSubmitting && !isImportReadOnly;
  const summaryTrips = tripPreviews.length;
  const summaryPlaces = tripPreviews.reduce((count, trip) => count + trip.places.length, 0);
  const pendingReviewCount = missingGroups.reduce((count, group) => count + group.photos.length, 0) + aiFailureGroups.length;
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
        <img src={photoDisplaySource(previewPhoto)} alt={photoAltText(previewPhoto)} />
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
    setLockedMissingOrderIds(undefined);
  }, [latestBatch?.id]);

  useEffect(() => {
    if (!previewPhoto) return;
    const closePreview = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePhotoPreview();
    };
    window.addEventListener("keydown", closePreview);
    return () => window.removeEventListener("keydown", closePreview);
  }, [closePhotoPreview, previewPhoto]);

  const startImport = (files: FileList | File[]) => {
    if (isImportReadOnly) return;
    const nextFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (nextFiles.length > 0) void importFiles(nextFiles);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) startImport(files);
    event.target.value = "";
  };

  const choosePhotos = async () => {
    if (isImporting || isImportReadOnly || nativePickerOpenRef.current) return;
    if (!isAndroidRuntime()) {
      inputRef.current?.click();
      return;
    }
    nativePickerOpenRef.current = true;
    try {
      const assets = await pickNativePhotoAssets();
      if (assets.length > 0) await importMobilePhotoAssets(assets);
    } catch (error) {
      console.error(error);
      inputRef.current?.click();
    } finally {
      nativePickerOpenRef.current = false;
    }
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (isImporting || isImportReadOnly) return;
    startImport(event.dataTransfer.files);
  };

  const acceptPending = async (item?: PendingItem) => {
    if (!item || isImportReadOnly) return;
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

  const resolveManualPending = async (item: PendingItem, body: ManualPlaceResolutionAction) => {
    if (isImportReadOnly) return;
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
    if (!item || isImportReadOnly) return;
    setLockedMissingOrderIds(missingGroups.map((group) => group.id));
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

  const inferAllPending = async (items: PendingItem[]) => {
    const ids = items.map((item) => item.id);
    if (!ids.length || isBulkInferring || isImportReadOnly) return;
    setLockedMissingOrderIds(undefined);
    setIsBulkInferring(true);
    setBulkInferProgress({ phase: "queued", done: 0, total: ids.length, steps: { ai: { done: 0, total: ids.length } } });
    setInferFeedback((feedback) => {
      const next = { ...feedback };
      for (const id of ids) {
        next[id] = { status: "running", message: t("readingContext") };
      }
      return next;
    });
    try {
      await inferPendingLocations(ids, (progress) => {
        setBulkInferProgress(progress);
      });
      setInferFeedback((feedback) => {
        const next = { ...feedback };
        for (const id of ids) delete next[id];
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("secondInferenceFailed");
      setInferFeedback((feedback) => {
        const next = { ...feedback };
        for (const id of ids) next[id] = { status: "error", message };
        return next;
      });
    } finally {
      setIsBulkInferring(false);
      setBulkInferProgress(undefined);
    }
  };

  const resolveAiFailure = async (item: PendingItem | undefined, action: "retry_vision" | "retry_embedding" | "retry_both" | "archive_exif") => {
    if (!item || isImportReadOnly) return;
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

  const resolveAllAiFailures = async (items: PendingItem[], action: BulkAiFailureAction) => {
    const ids = items.map((item) => item.id);
    if (!ids.length || isBulkResolvingAiFailures || isImportReadOnly) return;
    setIsBulkResolvingAiFailures(true);
    setBulkAiFailureAction(action);
    setBulkAiFailureProgress({ phase: "queued", done: 0, total: ids.length, steps: { ai: { done: 0, total: ids.length } } });
    setAcceptingIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
    try {
      await resolveImportAiFailures(ids, action, (progress) => {
        setBulkAiFailureProgress(progress);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("failed");
      setInferFeedback((feedback) => {
        const next = { ...feedback };
        for (const id of ids) next[id] = { status: "error", message };
        return next;
      });
    } finally {
      setIsBulkResolvingAiFailures(false);
      setBulkAiFailureAction(undefined);
      setBulkAiFailureProgress(undefined);
      setAcceptingIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };

  const resolveAllAiVisionFailures = async (items: PendingItem[]) => resolveAllAiFailures(items, "retry_vision");

  const resolveAllAiEmbeddingFailures = async (items: PendingItem[]) => resolveAllAiFailures(items, "retry_embedding");

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
          <div className="import-pick-column">
            <button className="import-pick-button" type="button" onClick={() => void choosePhotos()} disabled={isImporting || isImportReadOnly} title={t("choosePhotos")}>
              {isImporting ? <LoaderCircle className="animate-spin" size={18} /> : <FolderOpen size={18} />}
              <span>{isImporting ? t("importing") : t("choosePhotos")}</span>
            </button>
          </div>

          <div className="import-progress-stack" aria-label={t("importing")}>
            {progressSteps.map((step) => (
              <ProgressLine key={step.label} step={step} />
            ))}
          </div>

          {error ? <p className="photo-import-error">{error}</p> : null}
          {showOrganizingNotice ? (
            <p className="import-organizing-note">
              <LoaderCircle className="animate-spin" size={14} />
              <span>{t("organizingImportPreview")}</span>
            </p>
          ) : null}
          {isImportReadOnly && importProgress?.phase === "saving_state" ? <p className="import-save-note">{t("savingImportData")}</p> : null}
        </div>

        <div className="import-review-shell">
          {tripPreviews.length ? (
            <ReviewTree
              previews={tripPreviews}
              canEdit={isPendingBatch(latestBatch) && !isImportReadOnly}
              selectedPhotoId={selectedPhotoId}
              onMovePhoto={(photoId, placeId) => bindPhotoToPlace(photoId, placeId, "upload")}
              onOpenPreview={openPhotoPreview}
              onRemovePhoto={isPendingBatch(latestBatch) && !isImportReadOnly ? (photoId) => void cancelPendingImportPhotos([photoId]) : undefined}
              onRenamePlace={(placeId, name) => updatePlaceName(placeId, name)}
              onRenameTrip={(tripId, title) => updateTripTitle(tripId, title)}
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
            bulkProgress={bulkInferProgress}
            inferFeedback={inferFeedback}
            inferringIds={inferringIds}
            isBulkInferring={isBulkInferring}
            readOnly={isImportReadOnly}
            acceptingIds={acceptingIds}
            selectedPhotoId={selectedPhotoId}
            onAccept={(item) => void acceptPending(item)}
            onInferAll={(items) => void inferAllPending(items)}
            onInfer={(item) => void inferPending(item)}
            onManual={(item) => {
              setManualPending(item);
              if (item) {
                const photo = photos.find((photo) => item.relatedPhotoIds.includes(photo.id));
                openManualPlacePick(item.id, photo?.title ?? photo?.fileName ?? "");
              }
            }}
            onOpenPreview={openPhotoPreview}
            onReject={(photoIds) => void cancelPendingImportPhotos(photoIds)}
            onSelectPhoto={setSelectedPhotoId}
            t={t}
          />

          <AiFailureSuggestions
            failures={aiFailureGroups}
            bulkProgress={bulkAiFailureProgress}
            acceptingIds={acceptingIds}
            isBulkResolving={isBulkResolvingAiFailures}
            readOnly={isImportReadOnly}
            selectedPhotoId={selectedPhotoId}
            bulkAction={bulkAiFailureAction}
            onManual={(item) => {
              setManualPending(item);
              if (item) {
                const photo = photos.find((photo) => item.relatedPhotoIds.includes(photo.id));
                openManualPlacePick(item.id, photo?.title ?? photo?.fileName ?? "");
              }
            }}
            onOpenPreview={openPhotoPreview}
            onReject={(photoIds) => void cancelPendingImportPhotos(photoIds)}
            onResolveAllEmbedding={(items) => void resolveAllAiEmbeddingFailures(items)}
            onResolveAllVision={(items) => void resolveAllAiVisionFailures(items)}
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
                <span title={t("pending")}>{t("pending")} {pendingReviewCount}</span>
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
    {!isImportReadOnly && activeManualPending ? createPortal(
      <ManualPlaceResolutionModal
        sessionId={activeManualPending.id}
        photos={photos.filter((photo) => activeManualPending.relatedPhotoIds.includes(photo.id))}
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
        onPickPoint={(pendingId, name, nameDirty) => startManualPlacePick(pendingId, name, nameDirty, "upload")}
        onSubmit={(body) => void resolveManualPending(activeManualPending, body)}
      />,
      document.body,
    ) : null}
    </>
  );
}
