import fs from "node:fs/promises";
import path from "node:path";
import { safeArray } from "../domain/arrays.mjs";
import { toDateInput } from "../domain/dates.mjs";
import { parseExif } from "../domain/exif-parser.mjs";
import { geoContextFor, inferPreset, isUsableLocation } from "../domain/geo.mjs";
import { resolveImportedLocation, toAiEvidence } from "../domain/location-resolver.mjs";
import { buildPlacesForGroup } from "../domain/place-projector.mjs";
import { buildPhotoRoute, buildRoute } from "../domain/route-projector.mjs";
import { makePhotoTitle } from "../domain/text-normalizer.mjs";
import { rebuildTrips } from "../domain/trip-rebuilder.mjs";
import { dominantPresetsForPhotos, findAdjacentTrip, groupImportedPhotos } from "../domain/trip-resolver.mjs";
import { dataUrlToBuffer, extFromName, hashBuffer } from "../storage/file-storage.mjs";

export function createImportServices({
  analyzeTravelImage,
  inferMissingInfoWithImage,
  importJobs,
  makeId,
  paths,
  readState,
  readVectorIndex,
  repository,
  responseState,
  secretProvider,
  writeState,
  writeVectorIndex,
}) {
  const jobSubscribers = new Map();

  async function makeImportFilePayloadFromLocalFile(fullPath) {
    const buffer = await fs.readFile(fullPath);
    return {
      name: path.basename(fullPath),
      type: "image/jpeg",
      size: buffer.length,
      lastModified: (await fs.stat(fullPath)).mtimeMs,
      buffer,
    };
  }

  async function importPhotos(payload, progress = {}) {
    const state = await readState();
    const vectorIndex = await readVectorIndex();
    const now = new Date();
    const files = safeArray(payload.files).slice(0, 1000);
    if (files.length === 0) throw new Error("没有收到可导入图片。");

    const batchId = makeId("batch");
    const imported = [];
    const duplicateNames = [];
    const aiStats = {
      qwenCount: 0,
      fallbackCount: 0,
      embeddingCount: 0,
      qwenEmbeddingCount: 0,
      deterministicEmbeddingCount: 0,
    };
    const knownHashToPhoto = new Map(state.photos.filter((photo) => photo.originalHash).map((photo) => [photo.originalHash, photo]));
    const knownHashes = new Set(knownHashToPhoto.keys());
    const duplicatePhotoIds = new Set();
    progress.update?.({ phase: "exif", done: 0, total: files.length });
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      progress.update?.({ phase: "exif", done: index, total: files.length, currentFileName: file.name || `photo-${index + 1}` });
      const parsed = file.buffer ? { mime: file.type || "image/jpeg", buffer: file.buffer } : dataUrlToBuffer(file.dataUrl);
      const { mime, buffer } = parsed;
      const ext = extFromName(file.name, mime);
      const originalHash = hashBuffer(buffer);
      if (knownHashes.has(originalHash)) {
        duplicateNames.push(file.name || `duplicate-${index + 1}`);
        const duplicatePhoto = knownHashToPhoto.get(originalHash);
        if (duplicatePhoto?.id) duplicatePhotoIds.add(duplicatePhoto.id);
        progress.update?.({ phase: "exif", done: index + 1, total: files.length, currentFileName: file.name || `photo-${index + 1}` });
        if (payload.reanalyzeDuplicates) {
          const existingPhoto = duplicatePhoto;
          if (existingPhoto) {
            const exif = parseExif(buffer);
            const parsedLocation = isUsableLocation(exif.location) ? exif.location : existingPhoto.location;
            const preset = inferPreset(file.name, parsedLocation);
            const dataUrl = file.dataUrl ?? `data:${mime};base64,${buffer.toString("base64")}`;
            progress.update?.({ phase: "ai", done: index, total: files.length, currentFileName: file.name || `photo-${index + 1}` });
            const ai = await analyzePhoto({ fileName: file.name, mime, dataUrl, preset, location: parsedLocation, allowCloud: payload.allowCloudAi !== false });
            recordAiStats(ai, aiStats);
            const aiEvidence = toAiEvidence(ai, { makeId });
            const resolvedLocation = existingPhoto.location ?? parsedLocation;
            existingPhoto.tags = ai.tags;
            existingPhoto.title = ai.title || makePhotoTitle(existingPhoto);
            existingPhoto.aiCaption = ai.caption;
            existingPhoto.ai = aiEvidence;
            existingPhoto.locationResolution = resolveImportedLocation({
              location: resolvedLocation,
              aiEvidence,
              pendingReason: existingPhoto.pendingReason,
            });
            existingPhoto.aiProvider = ai.provider;
            existingPhoto.embeddingProvider = ai.embeddingProvider;
            existingPhoto.embeddingDimension = ai.embeddingDimension ?? ai.embedding?.length;
            existingPhoto.aiFallbackReason = ai.fallbackReason;
            if (parsedLocation && !existingPhoto.location) existingPhoto.location = parsedLocation;
            vectorIndex[existingPhoto.id] = ai.embedding;
          }
        }
        progress.update?.({ phase: "ai", done: index + 1, total: files.length, currentFileName: file.name || `photo-${index + 1}` });
        continue;
      }
      knownHashes.add(originalHash);
      const photoId = makeId("photo");
      const storageName = `${photoId}${ext}`;
      const thumbName = `${photoId}.jpg`;
      const storagePath = path.join(paths.photoDir, storageName);
      const thumbPath = path.join(paths.thumbDir, thumbName);
      await fs.writeFile(storagePath, buffer);
      const thumbnailSource = file.thumbnailDataUrl ? dataUrlToBuffer(file.thumbnailDataUrl).buffer : buffer;
      await fs.writeFile(thumbPath, thumbnailSource);
      const exif = parseExif(buffer);
      progress.update?.({ phase: "exif", done: index + 1, total: files.length, currentFileName: file.name || storageName });
      const parsedLocation = isUsableLocation(exif.location) ? exif.location : undefined;
      const preset = inferPreset(file.name, parsedLocation);
      const capturedAt =
        exif.capturedAt ??
        (file.lastModified ? new Date(file.lastModified).toISOString() : new Date(now.getTime() - (files.length - index) * 86400000).toISOString());
      const hasExifLocation = Boolean(parsedLocation);
      const location = parsedLocation;
      const dataUrl = file.dataUrl ?? `data:${mime};base64,${buffer.toString("base64")}`;
      progress.update?.({ phase: "ai", done: index, total: files.length, currentFileName: file.name || storageName });
      const ai = await analyzePhoto({ fileName: file.name, mime, dataUrl, preset, location, allowCloud: payload.allowCloudAi !== false });
      recordAiStats(ai, aiStats);
      const aiEvidence = toAiEvidence(ai, { makeId });
      const pendingReason = !location ? "missing_gps" : !exif.capturedAt ? "missing_time" : undefined;
      const photo = {
        id: photoId,
        fileName: file.name || storageName,
        title: ai.title || makePhotoTitle({ fileName: file.name || storageName, tags: ai.tags, aiCaption: ai.caption }),
        originalHash,
        mime,
        thumbnailUrl: `/data/thumbs/${thumbName}`,
        storageUrl: `/data/photos/${storageName}`,
        capturedAt,
        location,
        tags: ai.tags,
        aiCaption: ai.caption,
        ai: aiEvidence,
        locationResolution: resolveImportedLocation({ location, aiEvidence, pendingReason }),
        aiProvider: ai.provider,
        embeddingProvider: ai.embeddingProvider,
        embeddingDimension: ai.embeddingDimension ?? ai.embedding?.length,
        aiFallbackReason: ai.fallbackReason,
        importedBatchId: batchId,
        pendingReason,
        exifStatus: {
          time: exif.capturedAt ? "read" : "fallback",
          gps: hasExifLocation ? "read" : "missing",
        },
      };
      vectorIndex[photo.id] = ai.embedding;
      imported.push(photo);
      progress.update?.({ phase: "ai", done: index + 1, total: files.length, currentFileName: file.name || storageName });
    }

    progress.update?.({ phase: "grouping", done: files.length, total: files.length });
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
      const title = `${start.slice(0, 7)} ${preset.city}旅行${groups.length > 1 ? ` ${groupIndex + 1}` : ""}`;
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
      const archivableTripPhotos = tripPhotosAfter.filter((photo) => !hasMissingImportInfo(photo));
      const tripLocatedAfter = archivableTripPhotos.filter((photo) => photo.location);
      if (tripLocatedAfter.length) {
        const places = buildPlacesForGroup(archivableTripPhotos, tripId, { makeId });
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
              title: adjacentTrip ? `${toDateInput(tripDates[0]).slice(0, 7)} ${geoSummary.cities.length > 1 ? "欧洲多城" : geoSummary.cities[0]}旅行` : item.title,
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

    addLocationPendingItems(imported, pendingItems);
    addMissingInfoPendingItems(imported, pendingItems);

    const missing = imported.filter(hasMissingImportInfo);
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
      id: batchId,
      importedAt: now.toISOString(),
      totalCount: files.length,
      successCount: imported.length - missing.length,
      failedCount: missing.length,
      duplicateCount: duplicateNames.length,
      duplicatePhotoIds: Array.from(duplicatePhotoIds),
      duplicateNames,
      status: imported.length > 0 ? "pending_confirmation" : "confirmed",
      createdTripIds: createdTrips.map((trip) => trip.id),
      updatedTripIds: Array.from(updatedTripIds),
      addedPhotoIds: imported.map((photo) => photo.id),
      pendingItemIds: pendingItems.map((item) => item.id),
      storedFileNames: imported.map((photo) => path.basename(photo.storageUrl)),
      storedThumbnailNames: imported.map((photo) => path.basename(photo.thumbnailUrl)),
      aiStats,
      summary:
        imported.length > 0
          ? `新增 ${imported.length} 张照片，跳过 ${duplicateNames.length} 张重复照片，创建 ${createdTrips.length} 个待确认旅行档案，${missing.length} 张需要补充时间或地点。`
          : `没有新增照片，已跳过 ${duplicateNames.length} 张重复照片；其中 ${aiStats.qwenCount + aiStats.fallbackCount} 张完成了 AI 重新分析。`,
    };

    await writeVectorIndex(vectorIndex);
    await writeState({
      ...state,
      trips: workingTrips,
      photos: workingPhotos,
      placeNodes: workingPlaceNodes,
      routes: workingRoutes,
      importBatches: [...state.importBatches, batch],
      pendingItems: [...state.pendingItems, ...pendingItems],
    });
    progress.update?.({ phase: "completed", done: files.length, total: files.length });
    return responseState();
  }

  function startImportJob(payload) {
    const id = makeId("job");
    const total = safeArray(payload.files).length;
    const createdAt = new Date().toISOString();
    const initialProgress = {
      phase: "queued",
      done: 0,
      total,
      steps: {
        exif: { done: 0, total },
        ai: { done: 0, total },
      },
    };
    const job = {
      id,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      progress: initialProgress,
      progressEvents: [{ ...initialProgress, sequence: 0, createdAt }],
      result: undefined,
      error: undefined,
    };
    importJobs.set(id, job);
    repository.saveImportJob(job);
    setTimeout(async () => {
      const current = importJobs.get(id);
      if (!current) return;
      current.status = "processing";
      current.updatedAt = new Date().toISOString();
      current.progress = {
        phase: "exif",
        done: 0,
        total,
        steps: {
          exif: { done: 0, total },
          ai: { done: 0, total },
        },
      };
      appendProgressEvent(current);
      repository.saveImportJob(current);
      const updateProgress = (next) => {
        const steps = { ...(current.progress?.steps ?? {}) };
        if (next.phase === "exif" || next.phase === "ai") {
          steps[next.phase] = {
            done: next.done ?? steps[next.phase]?.done ?? 0,
            total: next.total ?? steps[next.phase]?.total ?? total,
            currentFileName: next.currentFileName,
          };
        }
        if (next.phase === "completed") {
          steps.exif = { ...(steps.exif ?? {}), done: total, total };
          steps.ai = { ...(steps.ai ?? {}), done: total, total };
        }
        current.progress = {
          ...(current.progress ?? {}),
          ...next,
          total: next.total ?? current.progress?.total ?? total,
          steps,
        };
        current.updatedAt = new Date().toISOString();
        appendProgressEvent(current);
        repository.saveImportJob(current);
      };
      try {
        current.result = await importPhotos(payload, { update: updateProgress });
        current.status = "completed";
        current.progress = {
          ...(current.progress ?? {}),
          phase: "completed",
          done: total,
          total,
          steps: {
            ...(current.progress?.steps ?? {}),
            exif: { done: total, total },
            ai: { done: total, total },
          },
        };
      } catch (error) {
        current.status = "failed";
        current.error = error instanceof Error ? error.message : "import job failed";
        current.progress = { ...(current.progress ?? {}), phase: "failed", total };
        appendProgressEvent(current);
      }
      current.updatedAt = new Date().toISOString();
      repository.saveImportJob(current);
      publishJobTerminal(current);
    }, 0);
    return job;
  }

  function appendProgressEvent(job) {
    const progress = job.progress;
    if (!progress) return;
    const previous = safeArray(job.progressEvents);
    const last = previous.at(-1);
    if (last && last.phase === progress.phase && last.done === progress.done && last.total === progress.total && last.currentFileName === progress.currentFileName) return;
    const sequence = Number.isFinite(Number(last?.sequence)) ? Number(last.sequence) + 1 : 0;
    const event = {
      ...JSON.parse(JSON.stringify(progress)),
      sequence,
      createdAt: job.updatedAt ?? new Date().toISOString(),
    };
    job.progressEvents = [...previous, event].slice(-3000);
    publishJobProgress(job.id, event);
  }

  function writeSse(res, eventName, payload) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function publishJobProgress(jobId, event) {
    const subscribers = jobSubscribers.get(jobId);
    if (!subscribers?.size) return;
    for (const res of subscribers) writeSse(res, "progress", event);
  }

  function publishJobTerminal(job) {
    const subscribers = jobSubscribers.get(job.id);
    if (!subscribers?.size) return;
    for (const res of subscribers) {
      writeSse(res, "done", { status: job.status, error: job.error });
      res.end();
    }
    jobSubscribers.delete(job.id);
  }

  function subscribeImportJob(id, req, res) {
    const job = getImportJob(id);
    if (!job) return false;
    res.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    for (const event of safeArray(job.progressEvents)) writeSse(res, "progress", event);
    if (job.status === "completed" || job.status === "failed") {
      writeSse(res, "done", { status: job.status, error: job.error });
      res.end();
      return true;
    }
    const subscribers = jobSubscribers.get(id) ?? new Set();
    subscribers.add(res);
    jobSubscribers.set(id, subscribers);
    req.on("close", () => {
      const current = jobSubscribers.get(id);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) jobSubscribers.delete(id);
    });
    return true;
  }

  function getImportJob(id) {
    const job = importJobs.get(id);
    return job ?? repository.getImportJob(id);
  }

  async function importAppleTestPhotos(options = {}) {
    const appleDir = path.join(paths.rootDir, "DESIGN_SPECS", "photo test", "apple");
    const entries = await fs.readdir(appleDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && /\.(jpe?g|png|heic)$/i.test(entry.name)) {
        files.push(await makeImportFilePayloadFromLocalFile(path.join(appleDir, entry.name)));
      }
    }
    const limitedFiles = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? files.slice(0, Number(options.limit)) : files;
    return importPhotos({
      files: limitedFiles,
      source: "apple-test",
      allowCloudAi: Boolean(options.allowCloudAi) || process.env.EARTH_ONLINE_TEST_CLOUD_AI === "1",
      reanalyzeDuplicates: Boolean(options.allowCloudAi),
    });
  }

  async function confirmImport(id) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === id);
    if (!batch || batch.status !== "pending_confirmation") return responseState();
    const openMissingItems = state.pendingItems.filter(
      (item) =>
        batch.pendingItemIds.includes(item.id) &&
        item.status === "open" &&
        ["missing_gps", "missing_time", "confirm_location_candidate"].includes(item.type),
    );
    if (openMissingItems.length) throw new Error("仍有待补信息未处理，不能确认导入。");
    await writeState({
      ...state,
      trips: state.trips.map((trip) => (batch.createdTripIds.includes(trip.id) ? { ...trip, status: "confirmed" } : trip)),
      importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "confirmed" } : item)),
    });
    return responseState();
  }

  async function inferPendingLocation(batchId, pendingId) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const pending = state.pendingItems.find((item) => item.id === pendingId);
    if (!batch || batch.status !== "pending_confirmation" || !pending || !batch.pendingItemIds.includes(pending.id)) return responseState();
    if (!["missing_gps", "missing_time", "confirm_location_candidate"].includes(pending.type)) return responseState();

    const proposal = await buildMissingInfoInferenceProposal(state, batch, pending);
    const nextPending = {
      ...pending,
      suggestion: proposal.suggestion,
      reason: proposal.reason,
      proposal: proposal.actionable ? proposal.proposal : undefined,
        inference: {
          status: proposal.actionable ? "suggested" : "keep_pending",
          confidence: proposal.confidence,
          reason: proposal.reason,
          displayTarget: proposal.displayTarget,
          displayTargetLabel: proposal.displayTargetLabel,
          displayTargetBadge: proposal.displayTargetBadge,
          updatedAt: new Date().toISOString(),
        },
    };
    await writeState({
      ...state,
      pendingItems: state.pendingItems.map((item) => (item.id === pending.id ? nextPending : item)),
    });
    return responseState();
  }

  async function rollbackImport(id) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === id);
    const latestPending = state.importBatches.filter((item) => item.status === "pending_confirmation").at(-1);
    if (!batch || batch.id !== latestPending?.id) throw new Error("MVP 只支持回撤最近一次待确认导入。");
    const photoIds = new Set(batch.addedPhotoIds);
    const tripIds = new Set(batch.createdTripIds);
    const affectedExistingTripIds = new Set(safeArray(batch.updatedTripIds));
    const pendingIds = new Set(batch.pendingItemIds);
    for (const name of safeArray(batch.storedFileNames)) {
      await fs.rm(path.join(paths.photoDir, path.basename(name)), { force: true });
    }
    for (const name of safeArray(batch.storedThumbnailNames)) {
      await fs.rm(path.join(paths.thumbDir, path.basename(name)), { force: true });
    }
    const vectorIndex = await readVectorIndex();
    for (const id of photoIds) delete vectorIndex[id];
    await writeVectorIndex(vectorIndex);
    const base = {
      ...state,
      photos: state.photos.filter((photo) => !photoIds.has(photo.id)),
      trips: state.trips.filter((trip) => !tripIds.has(trip.id)),
      placeNodes: state.placeNodes.filter((place) => !tripIds.has(place.tripId)),
      routes: state.routes.filter((route) => !tripIds.has(route.tripId)),
      pendingItems: state.pendingItems.filter((item) => !pendingIds.has(item.id)),
      importBatches: state.importBatches.map((item) => (item.id === id ? { ...item, status: "rolled_back" } : item)),
    };
    await writeState(rebuildTrips(base, affectedExistingTripIds, { makeId }));
    return responseState();
  }

  async function cancelImportPhotos(batchId, body = {}) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    const latestPending = state.importBatches.filter((item) => item.status === "pending_confirmation").at(-1);
    if (!batch || batch.id !== latestPending?.id) throw new Error("只能从最近一次待确认导入中取消照片。");
    const requested = new Set(safeArray(body.photoIds));
    const batchPhotoIds = new Set(batch.addedPhotoIds);
    const cancelIds = new Set([...requested].filter((id) => batchPhotoIds.has(id)));
    if (cancelIds.size === 0) return responseState();

    const cancelPhotos = state.photos.filter((photo) => cancelIds.has(photo.id));
    for (const photo of cancelPhotos) {
      if (photo.storageUrl) await fs.rm(path.join(paths.photoDir, path.basename(photo.storageUrl)), { force: true });
      if (photo.thumbnailUrl) await fs.rm(path.join(paths.thumbDir, path.basename(photo.thumbnailUrl)), { force: true });
    }

    const affectedTripIds = new Set(cancelPhotos.map((photo) => photo.tripId).filter(Boolean));
    const remainingAddedPhotoIds = batch.addedPhotoIds.filter((id) => !cancelIds.has(id));
    const emptyCreatedTripIds = new Set(
      batch.createdTripIds.filter((tripId) => !state.photos.some((photo) => photo.tripId === tripId && !cancelIds.has(photo.id))),
    );
    for (const tripId of emptyCreatedTripIds) affectedTripIds.delete(tripId);

    const pendingItems = state.pendingItems
      .map((item) => {
        if (!batch.pendingItemIds.includes(item.id)) return item;
        const relatedPhotoIds = safeArray(item.relatedPhotoIds).filter((id) => !cancelIds.has(id));
        return { ...item, relatedPhotoIds };
      })
      .filter((item) => !batch.pendingItemIds.includes(item.id) || item.relatedPhotoIds.length > 0);
    const pendingIds = new Set(pendingItems.filter((item) => batch.pendingItemIds.includes(item.id)).map((item) => item.id));

    const vectorIndex = await readVectorIndex();
    for (const id of cancelIds) delete vectorIndex[id];
    await writeVectorIndex(vectorIndex);

    const canceledMissingCount = cancelPhotos.filter((photo) => photo.pendingReason).length;
    const canceledSuccessCount = cancelIds.size - canceledMissingCount;
    const patchedBatch = {
      ...batch,
      totalCount: Math.max(0, batch.totalCount - cancelIds.size),
      successCount: Math.max(0, batch.successCount - canceledSuccessCount),
      failedCount: Math.max(0, batch.failedCount - canceledMissingCount),
      createdTripIds: batch.createdTripIds.filter((id) => !emptyCreatedTripIds.has(id)),
      addedPhotoIds: remainingAddedPhotoIds,
      pendingItemIds: batch.pendingItemIds.filter((id) => pendingIds.has(id)),
      storedFileNames: safeArray(batch.storedFileNames).filter((name) => !cancelPhotos.some((photo) => path.basename(photo.storageUrl ?? "") === path.basename(name))),
      storedThumbnailNames: safeArray(batch.storedThumbnailNames).filter((name) => !cancelPhotos.some((photo) => path.basename(photo.thumbnailUrl ?? "") === path.basename(name))),
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
    await writeState(rebuildTrips(base, affectedTripIds, { makeId }));
    return responseState();
  }

  async function mergeImportTrips(batchId) {
    const state = await readState();
    const batch = state.importBatches.find((item) => item.id === batchId);
    if (!batch || batch.createdTripIds.length <= 1) return responseState();
    const [targetTripId, ...removeTripIds] = batch.createdTripIds;
    const removeSet = new Set(removeTripIds);
    const batchPhotos = state.photos.filter((photo) => batch.addedPhotoIds.includes(photo.id));
    const dates = batchPhotos.map((photo) => photo.capturedAt).filter(Boolean).sort();
    const placeNodes = state.placeNodes.map((place) => (removeSet.has(place.tripId) ? { ...place, tripId: targetTripId } : place));
    const targetPlaces = placeNodes.filter((place) => place.tripId === targetTripId);
    const routes = state.routes.filter((route) => !batch.createdTripIds.includes(route.tripId)).concat(buildRoute(targetTripId, targetPlaces));
    await writeState({
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
    });
    return responseState();
  }

  async function analyzePhoto({ fileName, mime, dataUrl, preset, location, allowCloud }) {
    return analyzeTravelImage({
      rootDir: paths.rootDir,
      secretProvider,
      fileName,
      mime,
      dataUrl,
      preset,
      geoContext: geoContextFor(preset, location),
      allowCloud,
    });
  }

  function recordAiStats(ai, aiStats) {
    if (ai.provider === "qwen") aiStats.qwenCount += 1;
    else aiStats.fallbackCount += 1;
    if (Array.isArray(ai.embedding) && ai.embedding.length > 0) aiStats.embeddingCount += 1;
    if (ai.embeddingProvider === "qwen") aiStats.qwenEmbeddingCount += 1;
    else aiStats.deterministicEmbeddingCount += 1;
  }

  function addLocationPendingItems(imported, pendingItems) {
    const suggestedLocations = imported.filter((photo) => photo.locationResolution?.status === "suggested" && photo.locationResolution.candidateId);
    for (const photo of suggestedLocations) {
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
          candidate: photo.locationResolution.candidates.find((candidate) => candidate.id === photo.locationResolution.candidateId),
        },
      });
    }
  }

  function addMissingInfoPendingItems(imported, pendingItems) {
    for (const photo of imported.filter(hasMissingImportInfo)) {
      const missingGps = photo.exifStatus?.gps === "missing" || photo.pendingReason === "missing_gps";
      const missingTime = photo.exifStatus?.time !== "read";
      pendingItems.push({
        id: makeId("pending"),
        type: missingGps ? "missing_gps" : "missing_time",
        relatedPhotoIds: [photo.id],
        relatedTripId: photo.tripId,
        suggestion: `${photo.title ?? photo.fileName} 缺少${missingGps && missingTime ? " GPS 和 EXIF 时间" : missingGps ? " GPS" : " EXIF 时间"}，可手动触发 AI 二次推断。`,
        reason: "初次导入只完成单张照片理解；需要用户在待补信息中手动触发上下文推断后再确认。",
        status: "open",
      });
    }
  }

  function hasMissingImportInfo(photo) {
    return Boolean(photo.pendingReason) || photo.exifStatus?.gps === "missing" || photo.exifStatus?.time !== "read";
  }

  async function buildMissingInfoInferenceProposal(state, batch, pending) {
    const photo = state.photos.find((item) => item.id === pending.relatedPhotoIds[0]);
    if (!photo) return keepPending("找不到待补照片。", 0.2);
    const context = buildInferenceContextPhotos(state, batch, photo);
    const contextPhotos = [context.previousPhoto, context.nextPhoto].filter(Boolean);
    const contextPlaces = allowedInferencePlaces(state, photo, contextPhotos);
    const imagePayload = await readPhotoImagePayload(photo);
    if (!imagePayload) return keepPending("找不到当前待补照片原图，无法执行二次视觉推断。", 0);
    const inferenceInput = buildMissingInfoInferenceInput({ photo, context, contextPlaces });
    const aiResult = await inferMissingInfoWithImage({
      rootDir: paths.rootDir,
      secretProvider,
      dataUrl: imagePayload.dataUrl,
      mime: imagePayload.mime,
      inferenceInput,
      allowCloud: true,
    });
    return normalizeMissingInfoAiProposal({ aiResult, photo, contextPlaces });
  }

  function buildInferenceContextPhotos(state, batch, photo) {
    const batchPhotoIds = new Set(batch.addedPhotoIds);
    const currentTime = new Date(photo.capturedAt).getTime();
    let previous;
    let next;
    for (const item of state.photos) {
      if (item.id === photo.id) continue;
      const itemTime = new Date(item.capturedAt).getTime();
      if (!Number.isFinite(currentTime) || !Number.isFinite(itemTime)) continue;
      const distance = timeDistanceMs(item.capturedAt, photo.capturedAt);
      const isSameTripOrBatch = item.tripId === photo.tripId || batchPhotoIds.has(item.id);
      if (!isSameTripOrBatch) continue;
      if (itemTime <= currentTime) {
        if (!previous || distance < previous.distance) previous = { item, distance };
      } else if (!next || distance < next.distance) {
        next = { item, distance };
      }
    }
    return { previousPhoto: previous?.item, nextPhoto: next?.item };
  }

  function allowedInferencePlaces(state, photo, contextPhotos) {
    const tripIds = new Set([photo.tripId, ...contextPhotos.map((item) => item.tripId)].filter(Boolean));
    const placeIds = new Set([photo.placeNodeId, ...contextPhotos.map((item) => item.placeNodeId)].filter(Boolean));
    return state.placeNodes.filter((place) => tripIds.has(place.tripId) || placeIds.has(place.id));
  }

  async function readPhotoImagePayload(photo) {
    if (!photo.storageUrl) return undefined;
    const fileName = path.basename(photo.storageUrl);
    const fullPath = path.join(paths.photoDir, fileName);
    const buffer = await fs.readFile(fullPath).catch(() => undefined);
    if (!buffer) return undefined;
    const ext = path.extname(fileName).toLowerCase();
    const mime = photo.mime || (ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".heic" ? "image/heic" : "image/jpeg");
    return {
      mime,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
    };
  }

  function buildMissingInfoInferenceInput({ photo, context, contextPlaces }) {
    return {
      task: "missing_info_second_pass",
      currentPhoto: {
        id: photo.id,
        fileName: photo.fileName,
        capturedAt: photo.capturedAt,
        exifStatus: photo.exifStatus,
        pendingReason: photo.pendingReason,
        location: photo.location,
        initialAnalysis: {
          title: photo.title,
          caption: photo.aiCaption,
          tags: photo.tags ?? [],
          visiblePlaceNames: photo.ai?.visiblePlaceNames ?? [],
          locationCandidates: photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [],
          uncertainties: photo.ai?.uncertainties ?? [],
          locationResolution: photo.locationResolution,
        },
      },
      neighborContext: {
        role: "advisory_only",
        previousPhoto: serializeNeighborPhoto(context.previousPhoto, photo, contextPlaces),
        nextPhoto: serializeNeighborPhoto(context.nextPhoto, photo, contextPlaces),
      },
      allowedPlaces: contextPlaces.map((place) => ({
        id: place.id,
        name: place.name,
        displayName: place.displayName,
        city: place.city,
        country: place.country,
        center: place.center,
        tripId: place.tripId,
      })),
      constraints: {
        currentPhotoImageIsPrimaryEvidence: true,
        neighborImagesProvided: false,
        neighborGpsIsReferenceOnly: true,
        candidatePointPrecision: "estimated",
        lowConfidenceThresholdAppliesOnlyToMissingPhoto: 0.55,
      },
    };
  }

  function serializeNeighborPhoto(photo, currentPhoto, contextPlaces) {
    if (!photo) return undefined;
    const place = contextPlaces.find((item) => item.id === photo.placeNodeId);
    return {
      id: photo.id,
      capturedAt: photo.capturedAt,
      timeDeltaMinutes: Number.isFinite(timeDistanceMs(photo.capturedAt, currentPhoto.capturedAt))
        ? Math.round(timeDistanceMs(photo.capturedAt, currentPhoto.capturedAt) / 60000)
        : undefined,
      gps: photo.location,
      exifStatus: photo.exifStatus,
      tripId: photo.tripId,
      placeNodeId: photo.placeNodeId,
      placeName: place?.displayName ?? place?.name,
      city: place?.city,
      country: place?.country,
      title: photo.title,
      caption: photo.aiCaption,
      tags: photo.tags ?? [],
      visiblePlaceNames: photo.ai?.visiblePlaceNames ?? [],
      locationCandidates: photo.locationResolution?.candidates ?? photo.ai?.locationCandidates ?? [],
      uncertainties: photo.ai?.uncertainties ?? [],
    };
  }

  function normalizeMissingInfoAiProposal({ aiResult, photo, contextPlaces }) {
    if (aiResult.action === "bind_photos_to_place") {
      const place = contextPlaces.find((item) => item.id === aiResult.targetPlaceId);
      if (!place) return keepPending("AI 建议的目标地点不在后端允许的地点列表中。", aiResult.confidence ?? 0);
      if (isMissingGpsPhoto(photo) && Number(aiResult.confidence ?? 0) < 0.55) return keepPending(aiResult.reason || "待补照片地点置信度不足。", aiResult.confidence ?? 0);
      return {
        actionable: true,
        confidence: aiResult.confidence,
        displayTarget: `合并 ${place.displayName ?? place.name}`,
        displayTargetLabel: place.displayName ?? place.name,
        displayTargetBadge: "合并",
        suggestion: `合并 ${place.displayName ?? place.name}`,
        reason: aiResult.reason,
        proposal: {
          action: "bind_photos_to_place",
          photoIds: [photo.id],
          placeId: place.id,
          confidence: aiResult.confidence,
          reason: aiResult.reason,
        },
      };
    }

    if (aiResult.action === "create_place_from_candidate") {
      const candidate = aiResult.candidate;
      if (!candidate?.name || !candidate.point) return keepPending(candidate?.reason || "AI 未给出可创建地点的合法名称或估计坐标。", candidate?.confidence ?? 0);
      if (isMissingGpsPhoto(photo) && Number(candidate.confidence ?? 0) < 0.55) return keepPending(candidate.reason || "待补照片地点置信度不足。", candidate.confidence ?? 0);
      return {
        actionable: true,
        confidence: candidate.confidence,
        displayTarget: `新地点 ${candidate.name}`,
        displayTargetLabel: candidate.name,
        displayTargetBadge: "新地点",
        suggestion: `新地点 ${candidate.name}`,
        reason: candidate.reason,
        proposal: {
          action: "create_place_from_candidate",
          tripId: photo.tripId,
          photoIds: [photo.id],
          candidate: {
            ...candidate,
            source: "ai_context_inference",
            precision: "estimated",
          },
        },
      };
    }

    return keepPending(aiResult.reason || "AI 认为当前照片仍无法可靠判断地点。", aiResult.confidence ?? 0);
  }

  function isMissingGpsPhoto(photo) {
    return photo.pendingReason === "missing_gps" || photo.exifStatus?.gps === "missing" || !isUsableLocation(photo.location);
  }

  function keepPending(reason, confidence) {
    return {
      actionable: false,
      confidence,
      displayTarget: "仍待确认",
      displayTargetLabel: "待确认",
      displayTargetBadge: "待确认",
      suggestion: "AI 暂不建议自动归档，仍需手动处理。",
      reason,
      proposal: { action: "keep_pending", confidence, reason },
    };
  }

  function timeDistanceMs(left, right) {
    if (!left || !right) return Number.MAX_SAFE_INTEGER;
    return Math.abs(new Date(left).getTime() - new Date(right).getTime());
  }

  return {
    importPhotos,
    startImportJob,
    getImportJob,
    subscribeImportJob,
    importAppleTestPhotos,
    confirmImport,
    rollbackImport,
    cancelImportPhotos,
    inferPendingLocation,
    mergeImportTrips,
  };
}
