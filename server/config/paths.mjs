import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, "..", "..");
export const dataDir = process.env.EARTH_ONLINE_DATA_DIR ? path.resolve(process.env.EARTH_ONLINE_DATA_DIR) : path.join(rootDir, "data");
export const photoDir = path.join(dataDir, "photos");
export const thumbDir = path.join(dataDir, "thumbnails");
export const dbPath = path.join(dataDir, "db.json");
export const vectorPath = path.join(dataDir, "vector-index.json");
export const distDir = path.join(rootDir, "dist");
export const port = Number(process.env.EARTH_ONLINE_PORT ?? 8787);
