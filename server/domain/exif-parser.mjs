function readAscii(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString("ascii").replace(/\0/g, "").trim();
}

function parseTiff(tiff) {
  if (tiff.length < 8) return {};
  const little = readAscii(tiff, 0, 2) === "II";
  const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const rational = (o) => {
    const denominator = u32(o + 4);
    return denominator ? u32(o) / denominator : 0;
  };
  const parseIfd = (start) => {
    const entries = new Map();
    const count = u16(start);
    for (let i = 0; i < count; i += 1) {
      const entry = start + 2 + i * 12;
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
      const text = readAscii(tiff, date.count > 4 ? date.value : date.raw, date.count);
      const match = text.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (match) capturedAt = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    }
  }
  let location;
  if (gpsIfd) {
    const gps = parseIfd(gpsIfd);
    const latRef = readAscii(tiff, gps.get(1)?.raw ?? 0, 2);
    const lat = gps.get(2);
    const lngRef = readAscii(tiff, gps.get(3)?.raw ?? 0, 2);
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

export function parseExif(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return {};
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1 && readAscii(buffer, offset + 4, 6).startsWith("Exif")) {
      return parseTiff(buffer.subarray(offset + 10, offset + 2 + length));
    }
    offset += 2 + length;
  }
  return {};
}
