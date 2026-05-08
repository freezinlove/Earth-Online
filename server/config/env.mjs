import fs from "node:fs";
import path from "node:path";

const envCache = new Map();

export function readDotEnv(rootDir = process.cwd()) {
  const envPath = path.join(rootDir, ".env");
  if (envCache.has(envPath)) return envCache.get(envPath);
  if (!fs.existsSync(envPath)) {
    envCache.set(envPath, {});
    return {};
  }

  const entries = {};
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    entries[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }

  envCache.set(envPath, entries);
  return entries;
}

export function envValue(rootDir = process.cwd(), key, fallback) {
  return process.env[key] ?? readDotEnv(rootDir)[key] ?? fallback;
}
