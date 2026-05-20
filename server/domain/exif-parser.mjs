import { parseExifBytes } from "../../shared/media/exif-core.mjs";

export function parseExif(buffer) {
  return parseExifBytes(buffer);
}
