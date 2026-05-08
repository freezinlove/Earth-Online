import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { EarthRepository } from "../server/repository.mjs";
import { emptyState } from "../server/domain/empty-state.mjs";
import { dataDir, dbPath, photoDir, rootDir, thumbDir, vectorPath } from "../server/config/paths.mjs";

export const scriptsRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function assertSafeDataDir(targetDir = dataDir) {
  const resolved = path.resolve(targetDir);
  const defaultDataDir = path.resolve(rootDir, "data");
  const configuredDataDir = path.resolve(dataDir);
  if (resolved !== defaultDataDir && resolved !== configuredDataDir) {
    throw new Error(`Refusing to modify unexpected data directory: ${resolved}`);
  }
  if (resolved === path.resolve(rootDir) || resolved.length < 6) {
    throw new Error(`Refusing to modify unsafe data directory: ${resolved}`);
  }
  return resolved;
}

export async function ensureDataDirs() {
  await fs.mkdir(photoDir, { recursive: true });
  await fs.mkdir(thumbDir, { recursive: true });
}

export async function resetDataDir({ deleteFiles = true } = {}) {
  const resolved = assertSafeDataDir(dataDir);
  await fs.mkdir(resolved, { recursive: true });
  for (const name of ["earth-online.sqlite", "earth-online.sqlite-shm", "earth-online.sqlite-wal", "db.json", "vector-index.json"]) {
    await fs.rm(path.join(resolved, name), { force: true });
  }
  if (deleteFiles) {
    await fs.rm(photoDir, { recursive: true, force: true });
    await fs.rm(thumbDir, { recursive: true, force: true });
  }
  await ensureDataDirs();
  await fs.writeFile(vectorPath, JSON.stringify({}, null, 2), "utf8");
}

export async function saveEmptyState() {
  await ensureDataDirs();
  const repository = new EarthRepository({ dataDir, dbJsonPath: dbPath });
  await repository.ensureInitialized();
  repository.saveState(emptyState);
  repository.close();
  await fs.writeFile(vectorPath, JSON.stringify({}, null, 2), "utf8");
}

export async function copyDirectory(source, target) {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

export function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".heic") return "image/heic";
  return "image/jpeg";
}
