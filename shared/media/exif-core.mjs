function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array();
}

function readAscii(bytes, offset, length) {
  if (offset < 0 || length <= 0 || offset >= bytes.length) return "";
  return Array.from(bytes.subarray(offset, Math.min(bytes.length, offset + length)))
    .map((byte) => String.fromCharCode(byte))
    .join("")
    .replace(/\0/g, "")
    .trim();
}

function parseTiff(input) {
  const bytes = toBytes(input);
  if (bytes.length < 8) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = readAscii(bytes, 0, 2) === "II";
  const u16 = (offset) => (offset + 2 <= bytes.length ? view.getUint16(offset, little) : 0);
  const u32 = (offset) => (offset + 4 <= bytes.length ? view.getUint32(offset, little) : 0);
  const rational = (offset) => {
    if (offset + 8 > bytes.length) return 0;
    const denominator = u32(offset + 4);
    return denominator ? u32(offset) / denominator : 0;
  };
  const parseIfd = (start) => {
    const entries = new Map();
    if (start + 2 > bytes.length) return entries;
    const count = u16(start);
    for (let index = 0; index < count; index += 1) {
      const entry = start + 2 + index * 12;
      if (entry + 12 > bytes.length) break;
      entries.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), value: u32(entry + 8), raw: entry + 8 });
    }
    return entries;
  };

  const root = parseIfd(u32(4));
  const exifIfd = root.get(0x8769)?.value;
  const gpsIfd = root.get(0x8825)?.value;
  let capturedAt;
  if (exifIfd) {
    const exif = parseIfd(exifIfd);
    const date = exif.get(0x9003) ?? exif.get(0x0132);
    if (date) {
      const offset = date.count > 4 ? date.value : date.raw;
      const text = readAscii(bytes, offset, date.count);
      const match = text.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (match) capturedAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    }
  }

  let location;
  if (gpsIfd) {
    const gps = parseIfd(gpsIfd);
    const latRef = readAscii(bytes, gps.get(1)?.raw ?? 0, 2);
    const lat = gps.get(2);
    const lngRef = readAscii(bytes, gps.get(3)?.raw ?? 0, 2);
    const lng = gps.get(4);
    if (lat && lng) {
      const toDeg = (entry) => rational(entry.value) + rational(entry.value + 8) / 60 + rational(entry.value + 16) / 3600;
      location = {
        lat: toDeg(lat) * (latRef === "S" ? -1 : 1),
        lng: toDeg(lng) * (lngRef === "W" ? -1 : 1),
      };
    }
  }
  return { capturedAt, location };
}

export function parseExifBytes(input) {
  const bytes = toBytes(input);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2, false);
    if (length <= 0 || offset + 2 + length > bytes.length) break;
    if (marker === 0xe1 && readAscii(bytes, offset + 4, 6).startsWith("Exif")) {
      return parseTiff(bytes.subarray(offset + 10, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return {};
}
