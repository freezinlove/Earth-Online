export function createProgressEvent(progress, sequence, { now = () => new Date().toISOString() } = {}) {
  return {
    ...progress,
    sequence,
    createdAt: now(),
  };
}

export function createJob({ id, total = 0, phase = "queued", now = () => new Date().toISOString() } = {}) {
  if (!id) throw new TypeError("createJob requires id");
  const createdAt = now();
  const progress = { phase, done: 0, total };
  return {
    id,
    status: "processing",
    createdAt,
    updatedAt: createdAt,
    progress,
    progressEvents: [createProgressEvent(progress, 1, { now })],
  };
}

export function createJobProgressRecorder({
  id,
  total = 0,
  phase = "queued",
  now = () => new Date().toISOString(),
  save,
  onProgress,
} = {}) {
  const job = createJob({ id, total, phase, now });
  let sequence = job.progressEvents.length;
  save?.(job);
  return {
    job,
    update(progress) {
      sequence += 1;
      job.progress = progress;
      job.progressEvents = [...(job.progressEvents ?? []), createProgressEvent(progress, sequence, { now })];
      job.updatedAt = now();
      onProgress?.(progress);
      save?.(job);
    },
    complete(result) {
      job.status = "completed";
      job.result = result;
      job.updatedAt = now();
      save?.(job);
    },
    fail(error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = now();
      save?.(job);
    },
  };
}
