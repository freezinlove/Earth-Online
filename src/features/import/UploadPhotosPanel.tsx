import { Check, Circle, Clock3, FileImage, FolderOpen, ImagePlus, LoaderCircle, MapPin, RotateCcw, Sparkles, X } from "lucide-react";
import type { ChangeEvent, DragEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { capturedDateLabel } from "@/domain/datetime";
import { photoAltText, placeLabel, tripLabel } from "@/domain/labels";
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

type MissingTargetDisplay = {
  label: string;
  badge?: string;
};

type InferFeedback = {
  status: "running" | "done" | "error";
  message: string;
};

const thumbnailLimit = 9;

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
  if (!startDate && !endDate) return "待补时间";
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
  return photo.pendingReason === "missing_gps" || photo.exifStatus?.gps === "missing" || photo.locationResolution?.status === "missing";
}

function needsTime(photo: Photo) {
  return photo.pendingReason === "missing_time" || photo.exifStatus?.time === "missing";
}

function hasMissingInfo(photo: Photo) {
  return needsGps(photo) || needsTime(photo);
}

function isMissingInfoPending(item: PendingItem) {
  return item.type === "missing_gps" || item.type === "missing_time" || item.type === "confirm_location_candidate";
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
}: {
  importProgress?: ImportJobProgress;
  isImporting: boolean;
  latestBatch?: ImportBatch;
}): ImportStep[] {
  const latestTotal = latestBatch?.totalCount ?? 0;
  const liveTotal = Math.max(
    importProgress?.total ?? 0,
    importProgress?.steps?.reading?.total ?? 0,
    importProgress?.steps?.exif?.total ?? 0,
    importProgress?.steps?.ai?.total ?? 0,
  );
  const completed = Boolean(latestBatch && !isImporting);

  if ((isImporting && importProgress) || completed) {
    const progressTotal = isImporting ? liveTotal : latestTotal;
    const total = Math.max(progressTotal, 1);
    const phase = completed ? "completed" : importProgress?.phase;
    const readingDone = importProgress?.steps?.reading?.done ?? (phase === "reading" ? importProgress?.done ?? 0 : total);
    const exifDone =
      importProgress?.steps?.exif?.done ??
      (phase === "exif" ? importProgress?.done ?? 0 : phase === "ai" || phase === "grouping" || phase === "completed" ? total : 0);
    const aiDone =
      importProgress?.steps?.ai?.done ??
      (phase === "ai" ? importProgress?.done ?? 0 : phase === "grouping" || phase === "completed" ? total : 0);

    return [
      { icon: FileImage, label: "读取照片", done: Math.min(readingDone, total), total, active: phase === "reading" },
      { icon: Clock3, label: "解析 EXIF", done: Math.min(exifDone, total), total, active: phase === "exif" },
      { icon: Sparkles, label: "AI 图片理解", done: Math.min(aiDone, total), total, active: phase === "ai" },
    ];
  }

  return [];
}

function buildTripPreview({
  batch,
  photos,
  placeNodes,
  trips,
}: {
  batch?: ImportBatch;
  photos: Photo[];
  placeNodes: PlaceNode[];
  trips: Trip[];
}): TripPreview[] {
  if (!batch) return [];
  const importedPhotoIds = new Set(batch.addedPhotoIds);
  const importedPhotos = photos.filter((photo) => importedPhotoIds.has(photo.id));
  const archivablePhotos = importedPhotos.filter((photo) => !hasMissingInfo(photo));
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
            label: placeLabel(place),
            isNew: createdTripIds.has(trip.id) || place.photoIds.every((id) => importedPhotoIds.has(id)) || place.pending,
            photos: placePhotos,
            timeLabel: compactTimeLabel(place.timeRange.start, place.timeRange.end),
          };
        });
      const placedPhotoIds = new Set(places.flatMap((place) => place.photos.map((photo) => photo.id)));
      const unplacedPhotos = tripPhotos.filter((photo) => !placedPhotoIds.has(photo.id));

      if (unplacedPhotos.length) {
        places.push({
          label: "待定",
          isNew: true,
          photos: unplacedPhotos,
          timeLabel: photosTimeLabel(unplacedPhotos),
        });
      }

      return {
        trip,
        isNew: createdTripIds.has(trip.id),
        places: places.sort((left, right) => (left.timeLabel === "待补时间" ? "99.99" : left.timeLabel).localeCompare(right.timeLabel === "待补时间" ? "99.99" : right.timeLabel)),
      };
    })
    .filter((item): item is TripPreview => Boolean(item))
    .sort((left, right) => left.trip.dateRange.start.localeCompare(right.trip.dateRange.start));
}

function groupMissingPreviews(batch: ImportBatch | undefined, photos: Photo[], pendingItems: PendingItem[]): MissingPreview[] {
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

  const groups = new Map<string, MissingPreview>();
  for (const photo of imported) {
    const gps = needsGps(photo);
    const time = needsTime(photo);
    if (!gps && !time) continue;

    const target = gps && time ? `${photoSuggestionTarget(photo)} · ${shortDate(photo.capturedAt)}` : gps ? photoSuggestionTarget(photo) : shortDate(photo.capturedAt);
    const icon = gps && time ? "⌖◷" : gps ? "⌖" : "◷";
    const key = `${icon}-${target}`;
    const candidate = bestCandidate(photo);
    const existing = groups.get(key);
    if (existing) {
      existing.photos.push(photo);
      existing.confidence = Math.max(existing.confidence ?? 0, candidate?.confidence ?? photo.locationResolution?.confidence ?? 0);
    } else {
      groups.set(key, {
        id: key,
        icon,
        label: gps && time ? "GPS / TIME" : gps ? "GPS" : "TIME",
        target,
        photos: [photo],
        confidence: candidate?.confidence ?? photo.locationResolution?.confidence,
        pending: pendingByPhoto.get(photo.id),
      });
    }
  }

  return [...groups.values()];
}

function PhotoStrip({ photos, selectedPhotoId, onSelect }: { photos: Photo[]; selectedPhotoId?: string; onSelect: (photoId: string) => void }) {
  const visible = photos.slice(0, thumbnailLimit);
  const hidden = photos.length - visible.length;

  return (
    <div className="import-photo-strip">
      {visible.map((photo) => (
        <button
          key={photo.id}
          className="import-thumb"
          data-active={selectedPhotoId === photo.id || undefined}
          onClick={() => onSelect(photo.id)}
          title={photo.fileName}
          type="button"
        >
          <img src={photo.thumbnailUrl} alt={photoAltText(photo)} />
        </button>
      ))}
      {hidden > 0 ? <span className="import-thumb-more">+{hidden}</span> : null}
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
  onSelectPhoto,
}: {
  previews: TripPreview[];
  selectedPhotoId?: string;
  onSelectPhoto: (photoId: string) => void;
}) {
  if (!previews.length) return null;

  return (
    <section className="import-review-tree" aria-label="归档树">
      {previews.map((preview) => (
        <div key={preview.trip.id} className="import-trip-node" data-new={preview.isNew || undefined}>
          <div className="import-node-label import-node-label-trip">
            {preview.isNew ? <Circle size={12} /> : <span className="import-solid-dot" />}
            <span>{tripLabel(preview.trip)}</span>
            <em>{preview.isNew ? "新建旅程" : "已有旅程"}</em>
          </div>
          <div className="import-place-branch">
            {preview.places.map((placePreview) => (
              <div key={placePreview.place?.id ?? `${preview.trip.id}-${placePreview.label}`} className="import-place-node" data-new={placePreview.isNew || undefined}>
                <div className="import-node-label">
                  {placePreview.isNew ? <Circle size={10} /> : <span className="import-solid-dot import-solid-dot-small" />}
                  <MapPin size={14} />
                  <span>{placePreview.label}</span>
                  <em>{placePreview.isNew ? "新地点" : "合并"}</em>
                  <time>{placePreview.timeLabel}</time>
                </div>
                <PhotoStrip photos={placePreview.photos} selectedPhotoId={selectedPhotoId} onSelect={onSelectPhoto} />
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
  selectedPhotoId,
  onAccept,
  onInfer,
  onReject,
  onSelectPhoto,
}: {
  groups: MissingPreview[];
  inferFeedback: Record<string, InferFeedback>;
  inferringIds: Set<string>;
  selectedPhotoId?: string;
  onAccept: (item?: PendingItem) => void;
  onInfer: (item?: PendingItem) => void;
  onReject: (photoIds: string[]) => void;
  onSelectPhoto: (photoId: string) => void;
}) {
  if (!groups.length) return null;

  return (
    <section className="import-missing" aria-label="待确认建议">
      <div className="import-missing-heading">
        <span>待补信息</span>
        <small>{groups.reduce((count, group) => count + group.photos.length, 0)} 张</small>
      </div>
      <div className="import-missing-list">
        {groups.map((group) => {
          const isInferring = Boolean(group.pending && inferringIds.has(group.pending.id));
          const actionable = Boolean(group.pending?.proposal && group.pending.proposal.action !== "keep_pending");
          const suggestedTarget = pendingProposalTarget(group.pending, group.target);
          const feedback = group.pending ? inferFeedback[group.pending.id] : undefined;
          const statusLabel =
            feedback?.status === "running"
              ? "推断中"
              : feedback?.status === "done"
                ? "已更新"
                : feedback?.status === "error"
                  ? "失败"
                  : isInferring
                    ? "推断中"
                    : actionable
                      ? "AI 建议"
                      : group.pending?.inference?.status === "keep_pending"
                        ? "仍待定"
                        : "待推断";
          const confidence = group.pending?.inference?.confidence ?? group.confidence;
          return (
            <div key={group.id} className="import-missing-row" title={group.pending?.reason ?? group.label}>
              <PhotoStrip photos={group.photos} selectedPhotoId={selectedPhotoId} onSelect={onSelectPhoto} />
              <span className="import-missing-field">{group.label}</span>
              <span className="import-ai-suggest" data-status={statusLabel}>{statusLabel}</span>
              <strong className="import-missing-target">
                <span>{suggestedTarget.label}</span>
                {suggestedTarget.badge ? <em>{suggestedTarget.badge}</em> : null}
              </strong>
              <span className="import-confidence" aria-label="置信度">
                <span style={{ width: `${Math.max(18, Math.min(100, Math.round((confidence ?? 0.35) * 100)))}%` }} />
              </span>
              <button className="import-inline-cancel" onClick={() => onReject(group.photos.map((photo) => photo.id))} title="取消导入" type="button">
                <X size={13} />
              </button>
              <button className="import-inline-infer" onClick={() => onInfer(group.pending)} disabled={!group.pending || isInferring} title="AI 二次推断" type="button">
                {isInferring ? <LoaderCircle className="animate-spin" size={13} /> : <Sparkles size={13} />}
              </button>
              {actionable ? (
                <button className="import-inline-confirm" onClick={() => onAccept(group.pending)} title="确认建议" type="button">
                  <Check size={14} />
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

export function UploadPhotosPanel() {
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
  const acknowledgePendingItem = useAppStore((state) => state.acknowledgePendingItem);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inferringIds, setInferringIds] = useState<Set<string>>(() => new Set());
  const [inferFeedback, setInferFeedback] = useState<Record<string, InferFeedback>>({});
  const lastBatch = importBatches[importBatches.length - 1];
  const latestBatch = lastBatch?.status === "rolled_back" ? undefined : lastBatch;
  const importedIds = useMemo(() => new Set(latestBatch?.addedPhotoIds ?? []), [latestBatch?.addedPhotoIds]);
  const importedPhotos = useMemo(() => photos.filter((photo) => importedIds.has(photo.id)), [importedIds, photos]);
  const batchPendingItems = useMemo(
    () => pendingItems.filter((item) => latestBatch?.pendingItemIds.includes(item.id) && item.status === "open"),
    [latestBatch?.pendingItemIds, pendingItems],
  );
  const progressSteps = useMemo(() => buildProgressSteps({ importProgress, isImporting, latestBatch }), [importProgress, isImporting, latestBatch]);
  const tripPreviews = useMemo(() => buildTripPreview({ batch: latestBatch, photos, placeNodes, trips }), [latestBatch, photos, placeNodes, trips]);
  const missingGroups = useMemo(() => groupMissingPreviews(latestBatch, photos, pendingItems), [latestBatch, pendingItems, photos]);
  const canConfirm = isPendingBatch(latestBatch) && missingGroups.length === 0 && !isSubmitting;
  const canRollback = isPendingBatch(latestBatch) && !isSubmitting;
  const summaryTrips = tripPreviews.length;
  const summaryPlaces = tripPreviews.reduce((count, trip) => count + trip.places.length, 0);

  useEffect(() => {
    if (!selectedPhotoId && importedPhotos[0]) setSelectedPhotoId(importedPhotos[0].id);
  }, [importedPhotos, selectedPhotoId]);

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
    await acknowledgePendingItem(item.id, true);
  };

  const inferPending = async (item?: PendingItem) => {
    if (!item) return;
    setInferringIds((ids) => new Set(ids).add(item.id));
    setInferFeedback((feedback) => ({
      ...feedback,
      [item.id]: { status: "running", message: "正在读取前后照片上下文..." },
    }));
    try {
      await inferPendingLocation(item.id);
      setInferFeedback((feedback) => ({
        ...feedback,
        [item.id]: { status: "done", message: "二次推断已完成，结果已刷新" },
      }));
      window.setTimeout(() => {
        setInferFeedback((feedback) => {
          if (feedback[item.id]?.status !== "done") return feedback;
          const next = { ...feedback };
          delete next[item.id];
          return next;
        });
      }, 3200);
    } catch (error) {
      setInferFeedback((feedback) => ({
        ...feedback,
        [item.id]: { status: "error", message: error instanceof Error ? error.message : "二次推断失败" },
      }));
    } finally {
      setInferringIds((ids) => {
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
    <section
      className="photo-import-panel fixed inset-0 z-[70] overflow-y-auto bg-background/94 px-5 py-8 backdrop-blur-2xl md:px-24 md:py-12"
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
            <p className="text-xs font-semibold uppercase tracking-[0.34em] text-outline">Photo Intake</p>
            <h2 className="mt-2 font-serif text-4xl font-semibold leading-tight text-primary md:text-6xl">归档预演</h2>
          </div>
        </div>

        <input ref={inputRef} className="sr-only" type="file" accept="image/*" multiple onChange={handleFileChange} />

        <div className="import-intake" data-dragging={isDragging || undefined}>
          <button className="import-pick-button" type="button" onClick={() => inputRef.current?.click()} disabled={isImporting} title="选择照片">
            {isImporting ? <LoaderCircle className="animate-spin" size={18} /> : <FolderOpen size={18} />}
            <span>{isImporting ? "导入中" : "选择照片"}</span>
          </button>

          <div className="import-progress-stack" aria-label="导入进度">
            {progressSteps.map((step) => (
              <ProgressLine key={step.label} step={step} />
            ))}
          </div>

          {error ? <p className="photo-import-error">{error}</p> : null}
        </div>

        <div className="import-review-shell">
          {tripPreviews.length ? (
            <ReviewTree previews={tripPreviews} selectedPhotoId={selectedPhotoId} onSelectPhoto={setSelectedPhotoId} />
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
            selectedPhotoId={selectedPhotoId}
            onAccept={(item) => void acceptPending(item)}
            onInfer={(item) => void inferPending(item)}
            onReject={(photoIds) => void cancelPendingImportPhotos(photoIds)}
            onSelectPhoto={setSelectedPhotoId}
          />

          {(latestBatch || isImporting) ? (
            <footer className="import-command-bar">
              <div className="import-command-stats">
                <span title="新增照片"><FileImage size={15} />新增 {latestBatch?.addedPhotoIds.length ?? importProgress?.total ?? 0}</span>
                {(latestBatch?.duplicateCount ?? 0) > 0 ? <span title="重复跳过">重复跳过 {latestBatch?.duplicateCount}</span> : null}
                <span title="旅程"><Circle size={13} />旅程 {summaryTrips}</span>
                <span title="地点"><MapPin size={15} />地点 {summaryPlaces}</span>
                <span title="待确认">待确认 {batchPendingItems.length}</span>
              </div>
              <div className="import-command-actions">
                <button className="import-undo-button" onClick={() => void rollbackBatch()} disabled={!canRollback} type="button" title="撤回导入" aria-label="撤回导入">
                  <RotateCcw size={17} />
                </button>
                <button className="import-confirm-button" onClick={() => void confirmBatch()} disabled={!canConfirm} type="button">
                  {isSubmitting ? <LoaderCircle className="animate-spin" size={15} /> : null}
                  确认
                </button>
              </div>
            </footer>
          ) : null}
        </div>
      </div>
    </section>
  );
}
