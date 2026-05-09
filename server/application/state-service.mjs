import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { normalizeState } from "../domain/state-normalizer.mjs";
import { projectState } from "../domain/state-projector.mjs";

export function createStateService({ paths, repository }) {
  async function ensureStorage() {
    await fs.mkdir(paths.photoDir, { recursive: true });
    await fs.mkdir(paths.thumbDir, { recursive: true });
    if (paths.importJobDir) await fs.mkdir(paths.importJobDir, { recursive: true });
    await repository.ensureInitialized();
    if (!existsSync(paths.vectorPath)) {
      await fs.writeFile(paths.vectorPath, JSON.stringify({}, null, 2), "utf8");
    }
  }

  async function readState() {
    await ensureStorage();
    return normalizeState(repository.readState());
  }

  async function writeState(state) {
    const normalized = normalizeState(state);
    repository.saveState(normalized);
    return normalized;
  }

  async function readVectorIndex() {
    await ensureStorage();
    return JSON.parse(await fs.readFile(paths.vectorPath, "utf8"));
  }

  async function writeVectorIndex(index) {
    const tempPath = `${paths.vectorPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(index, null, 2), "utf8");
    await fs.rename(tempPath, paths.vectorPath);
  }

  async function responseState() {
    const state = await readState();
    return projectState(state);
  }

  return {
    ensureStorage,
    readState,
    writeState,
    readVectorIndex,
    writeVectorIndex,
    responseState,
  };
}
