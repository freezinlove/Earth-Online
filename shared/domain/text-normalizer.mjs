import { safeArray } from "./arrays.mjs";

function basenameWithoutExt(value) {
  const fileName = String(value ?? "未命名照片").split(/[\\/]/).pop() || "未命名照片";
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

export function normalizeTags(tags, preset) {
  const generic = new Set(["欧洲", "旅行", "城市", "建筑", "自然风光", "户外摄影"]);
  const normalized = safeArray(tags)
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .filter((tag) => !generic.has(tag));
  const seeded = normalized.length >= 4 ? normalized : [...normalized, ...(preset?.tags ?? [])];
  return Array.from(new Set(seeded)).slice(0, 10);
}

export function makePhotoTitle(photo) {
  const tag = safeArray(photo.tags).find((item) => !["旅行", "待确认", "城市", "建筑", "欧洲"].includes(item));
  if (tag) return String(tag).slice(0, 18);
  const caption = String(photo.aiCaption ?? "").match(/([\u4e00-\u9fa5A-Za-z0-9-]{2,18})/)?.[1];
  if (caption && !caption.includes("待确认")) return caption.slice(0, 18);
  return basenameWithoutExt(photo.fileName).slice(0, 18);
}

export function shortTimelineSourceLabel(title) {
  return String(title ?? "").replace(/^20\d{2}\s*/, "");
}
