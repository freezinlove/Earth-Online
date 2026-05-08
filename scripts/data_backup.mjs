import fs from "node:fs/promises";
import path from "node:path";
import { copyDirectory } from "./data_utils.mjs";
import { dataDir } from "../server/config/paths.mjs";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(dataDir, "backups", stamp);

await fs.mkdir(backupDir, { recursive: true });
for (const name of ["earth-online.sqlite", "earth-online.sqlite-shm", "earth-online.sqlite-wal", "vector-index.json"]) {
  try {
    await fs.copyFile(path.join(dataDir, name), path.join(backupDir, name));
  } catch {
    // A fresh empty project may not have all data files yet.
  }
}
for (const name of ["photos", "thumbnails"]) {
  try {
    await copyDirectory(path.join(dataDir, name), path.join(backupDir, name));
  } catch {
    // Missing folders are fine before the first import.
  }
}

console.log(`Backup created: ${backupDir}`);
