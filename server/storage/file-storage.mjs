import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { corsHeaders } from "../http/responses.mjs";

export function extFromName(name, mime) {
  const ext = path.extname(name || "").toLowerCase();
  if (ext) return ext;
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/heic") return ".heic";
  return ".jpg";
}

export function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function servePhoto(res, pathname, { photoDir, thumbDir }) {
  const isThumb = pathname.startsWith("/data/thumbs/");
  const baseDir = isThumb ? thumbDir : photoDir;
  const file = path.basename(decodeURIComponent(pathname.replace(isThumb ? "/data/thumbs/" : "/data/photos/", "")));
  const fullPath = path.join(baseDir, file);
  if (!fullPath.startsWith(baseDir) || !existsSync(fullPath)) {
    res.writeHead(404, corsHeaders);
    res.end("not found");
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".heic" ? "image/heic" : "image/jpeg";
  res.writeHead(200, { ...corsHeaders, "content-type": mime, "cache-control": "public, max-age=31536000" });
  res.end(await fs.readFile(fullPath));
}

export async function serveStatic(req, res, pathname, { distDir }) {
  const target = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = path.resolve(distDir, target);
  if (!fullPath.startsWith(distDir) || !existsSync(fullPath)) return false;
  const ext = path.extname(fullPath);
  const mime = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : ext === ".html" ? "text/html" : "application/octet-stream";
  res.writeHead(200, { "content-type": `${mime}; charset=utf-8` });
  res.end(await fs.readFile(fullPath));
  return true;
}
