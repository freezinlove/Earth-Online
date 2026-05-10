import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const downloadDir = path.join(rootDir, "external", "geodata", "downloads");
const baseUrl = "https://download.geonames.org/export/dump";
const files = ["cities500.zip", "alternateNamesV2.zip", "countryInfo.txt", "admin1CodesASCII.txt", "admin2Codes.txt", "featureCodes_en.txt"];

await fs.mkdir(downloadDir, { recursive: true });

for (const file of files) {
  const target = path.join(downloadDir, file);
  const existing = await fs.stat(target).catch(() => undefined);
  if (existing?.size) {
    console.log(`${file}: already downloaded`);
    continue;
  }

  const url = `${baseUrl}/${file}`;
  console.log(`${file}: downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(target, buffer);
  console.log(`${file}: ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
}
