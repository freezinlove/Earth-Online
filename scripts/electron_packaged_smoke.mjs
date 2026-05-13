import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultExe = path.join(rootDir, "release", "win-unpacked", "Earth Online.exe");
const exePath = path.resolve(process.argv[2] ?? defaultExe);
const port = process.env.EARTH_ONLINE_SMOKE_PORT ?? "18787";
const token = process.env.EARTH_ONLINE_DESKTOP_TOKEN ?? `smoke-${Date.now()}`;
const dataDir = path.join(rootDir, "output", "electron-smoke-data");
const userDataDir = path.join(rootDir, "output", "electron-smoke-user-data");
const outLog = path.join(rootDir, "output", "electron-smoke.out.log");
const errLog = path.join(rootDir, "output", "electron-smoke.err.log");
const rendererReport = path.join(rootDir, "output", "electron-smoke-renderer.jsonl");

if (!existsSync(exePath)) {
  throw new Error(`Packaged Electron executable not found: ${exePath}`);
}

async function waitForJson(url, timeoutMs = 45000) {
  const started = Date.now();
  let lastError;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function waitForOk(url, timeoutMs = 45000) {
  const started = Date.now();
  let lastError;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function waitForRendererReports(count, timeoutMs = 45000) {
  const started = Date.now();
  let lastError;
  for (;;) {
    try {
      const text = await fs.readFile(rendererReport, "utf8");
      const reports = text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (reports.length >= count) return reports;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for renderer smoke reports: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function waitForImportJob(baseUrl, jobId) {
  const started = Date.now();
  for (;;) {
    const job = await waitForJson(`${baseUrl}/api/import/jobs/${jobId}?desktopToken=${encodeURIComponent(token)}`, 5000);
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(job.error ?? "Packaged import smoke job failed");
    if (Date.now() - started > 60000) throw new Error(`Timed out waiting for import job ${jobId}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function importSmokeImage(baseUrl) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
  const fileName = "electron-smoke.png";
  const form = new FormData();
  form.append("files", new Blob([png], { type: "image/png" }), fileName);
  form.append("allowCloudAi", "false");
  form.append("locale", "zh");
  form.append("fileMeta", JSON.stringify([{ name: fileName, type: "image/png", size: png.length, lastModified: Date.now() }]));

  const response = await fetch(`${baseUrl}/api/import/jobs?desktopToken=${encodeURIComponent(token)}`, {
    method: "POST",
    body: form,
    headers: {
      "x-earth-online-token": token,
    },
  });
  if (!response.ok) throw new Error(`Import smoke request failed: ${response.status} ${response.statusText}`);
  const job = await response.json();
  const completed = await waitForImportJob(baseUrl, job.id);
  const photo = completed.result?.photos?.find((item) => item.fileName === fileName);
  if (!photo?.thumbnailUrl) throw new Error("Import smoke did not produce a thumbnail URL");
  const thumbnail = await waitForOk(`${baseUrl}${photo.thumbnailUrl}`);
  return {
    jobId: job.id,
    photoId: photo.id,
    thumbnailStatus: thumbnail.status,
  };
}

function stopProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => resolve());
      return;
    }
    child.kill();
    child.once("exit", () => resolve());
  });
}

async function startPackagedApp({ markOnboardingComplete = false } = {}) {
  const stdout = await fs.open(outLog, "a");
  const stderr = await fs.open(errLog, "a");
  const child = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    detached: false,
    env: {
      ...process.env,
      EARTH_ONLINE_DATA_DIR: dataDir,
      EARTH_ONLINE_DESKTOP_TOKEN: token,
      EARTH_ONLINE_PORT: port,
      EARTH_ONLINE_USER_DATA_DIR: userDataDir,
      EARTH_ONLINE_SMOKE_MARK_ONBOARDING_COMPLETE: markOnboardingComplete ? "1" : "0",
      EARTH_ONLINE_SMOKE_RENDERER_REPORT: rendererReport,
    },
    stdio: ["ignore", stdout.fd, stderr.fd],
  });
  child.once("exit", () => {
    void stdout.close();
    void stderr.close();
  });
  return child;
}

await fs.mkdir(path.dirname(outLog), { recursive: true });
await fs.rm(dataDir, { recursive: true, force: true });
await fs.rm(userDataDir, { recursive: true, force: true });
await fs.writeFile(outLog, "");
await fs.writeFile(errLog, "");
await fs.writeFile(rendererReport, "");

let child = await startPackagedApp({ markOnboardingComplete: true });

try {
  const baseUrl = `http://127.0.0.1:${port}`;
  const state = await waitForJson(`${baseUrl}/api/state?desktopToken=${encodeURIComponent(token)}`);
  const storage = await waitForJson(`${baseUrl}/api/settings/storage?desktopToken=${encodeURIComponent(token)}`);
  const shell = await waitForOk(`${baseUrl}/`);
  const globeAsset = await waitForOk(`${baseUrl}/data/globe/land-far.bin`);
  const unauthorized = await fetch(`${baseUrl}/api/state`).catch(() => undefined);
  const importSmoke = await importSmokeImage(baseUrl);
  const firstReports = await waitForRendererReports(1);
  await stopProcessTree(child);

  child = await startPackagedApp();
  await waitForJson(`${baseUrl}/api/state?desktopToken=${encodeURIComponent(token)}`);
  const reports = await waitForRendererReports(2);
  const initialRenderer = firstReports[0];
  const secondRenderer = reports[1];

  if (initialRenderer.before.title !== "Earth_Online" || secondRenderer.before.title !== "Earth_Online") {
    throw new Error("Packaged renderer title smoke check failed");
  }
  if (secondRenderer.before.onboardingVisible !== false || secondRenderer.before.desktopPreferenceComplete !== true) {
    throw new Error("Packaged onboarding persistence smoke check failed");
  }
  if (path.resolve(storage.dataDir) !== path.resolve(dataDir)) {
    throw new Error(`Packaged storage API used ${storage.dataDir}, expected ${dataDir}`);
  }
  if (path.resolve(secondRenderer.before.desktopStorageCurrentDataDir) !== path.resolve(dataDir) || secondRenderer.before.desktopStorageEnvOverride !== true) {
    throw new Error("Packaged desktop storage bridge smoke check failed");
  }

  console.log(
    JSON.stringify(
      {
        exePath,
        baseUrl,
        dataDir,
        storage,
        trips: state.trips?.length ?? 0,
        photos: state.photos?.length ?? 0,
        shellStatus: shell.status,
        globeAssetStatus: globeAsset.status,
        unauthorizedStatus: unauthorized?.status,
        importSmoke,
        initialRenderer,
        secondRenderer,
        outLog,
        errLog,
      },
      null,
      2,
    ),
  );
} finally {
  await stopProcessTree(child);
}
