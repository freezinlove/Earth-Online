export const importConcurrencyDefaults = Object.freeze({
  metadata: 16,
  storageWrite: 16,
  ai: 200,
  embedding: 600,
  missingInference: 200,
});

export const importImageDefaults = Object.freeze({
  thumbnailMaxDimension: 720,
  thumbnailJpegQuality: 78,
  aiImageMaxDimension: 1200,
  aiImageJpegQuality: 82,
  displayImageMaxDimension: 1800,
  displayImageJpegQuality: 85,
});

export const importTimeoutDefaults = Object.freeze({
  aiRequestMs: 80000,
});

function numberFromConfig(config, key, fallback) {
  const value = Number(config?.[key] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function importPipelineConfig(config = {}) {
  return {
    concurrency: {
      metadata: numberFromConfig(config, "EARTH_ONLINE_IMPORT_METADATA_CONCURRENCY", importConcurrencyDefaults.metadata),
      storageWrite: numberFromConfig(config, "EARTH_ONLINE_IMPORT_STORAGE_WRITE_CONCURRENCY", importConcurrencyDefaults.storageWrite),
      ai: numberFromConfig(config, "EARTH_ONLINE_IMPORT_AI_CONCURRENCY", importConcurrencyDefaults.ai),
      embedding: numberFromConfig(config, "EARTH_ONLINE_IMPORT_EMBEDDING_CONCURRENCY", importConcurrencyDefaults.embedding),
      missingInference: numberFromConfig(config, "EARTH_ONLINE_MISSING_INFERENCE_CONCURRENCY", importConcurrencyDefaults.missingInference),
    },
    images: {
      thumbnailMaxDimension: numberFromConfig(config, "EARTH_ONLINE_THUMBNAIL_MAX_DIMENSION", importImageDefaults.thumbnailMaxDimension),
      thumbnailJpegQuality: numberFromConfig(config, "EARTH_ONLINE_THUMBNAIL_JPEG_QUALITY", importImageDefaults.thumbnailJpegQuality),
      aiImageMaxDimension: numberFromConfig(config, "EARTH_ONLINE_AI_IMAGE_MAX_DIMENSION", importImageDefaults.aiImageMaxDimension),
      aiImageJpegQuality: numberFromConfig(config, "EARTH_ONLINE_AI_IMAGE_JPEG_QUALITY", importImageDefaults.aiImageJpegQuality),
      displayImageMaxDimension: numberFromConfig(config, "EARTH_ONLINE_DISPLAY_IMAGE_MAX_DIMENSION", importImageDefaults.displayImageMaxDimension),
      displayImageJpegQuality: numberFromConfig(config, "EARTH_ONLINE_DISPLAY_IMAGE_JPEG_QUALITY", importImageDefaults.displayImageJpegQuality),
    },
    timeouts: {
      aiRequestMs: numberFromConfig(config, "AI_REQUEST_TIMEOUT_MS", importTimeoutDefaults.aiRequestMs),
    },
  };
}

export async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

export function createLimiter(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];
  const drain = () => {
    if (active >= max) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        active -= 1;
        drain();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
}

export function timeoutSignal(timeoutMs = importTimeoutDefaults.aiRequestMs) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  if (typeof globalThis.AbortSignal?.timeout === "function") return globalThis.AbortSignal.timeout(timeout);
  if (typeof globalThis.AbortController !== "function") return undefined;
  const controller = new globalThis.AbortController();
  globalThis.setTimeout(() => controller.abort(new Error("Request timed out")), timeout);
  return controller.signal;
}
