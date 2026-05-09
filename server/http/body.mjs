import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import Busboy from "busboy";

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeMultipartFileName(name = "photo") {
  return (
    path
      .basename(String(name))
      .split("")
      .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? "_" : char))
      .join("") || "photo"
  );
}

export async function readMultipartFormDataToDir(req, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const writes = [];
    let fileIndex = 0;
    const parser = Busboy({ headers: req.headers });

    parser.on("field", (name, value) => {
      fields[name] = value;
    });
    parser.on("file", (fieldName, file, info) => {
      fileIndex += 1;
      const originalName = info.filename || `photo-${fileIndex}`;
      const safeName = `${String(fileIndex).padStart(4, "0")}-${safeMultipartFileName(originalName)}`;
      const tempPath = path.join(targetDir, safeName);
      let size = 0;
      const write = createWriteStream(tempPath);
      file.on("data", (chunk) => {
        size += chunk.length;
      });
      file.on("error", reject);
      write.on("error", reject);
      file.pipe(write);
      writes.push(
        new Promise((writeResolve, writeReject) => {
          write.on("finish", () => {
            files.push({
              fieldName,
              name: originalName,
              type: info.mimeType || "application/octet-stream",
              size,
              tempPath,
            });
            writeResolve();
          });
          write.on("error", writeReject);
        }),
      );
    });
    parser.on("error", reject);
    parser.on("finish", async () => {
      try {
        await Promise.all(writes);
        files.sort((left, right) => left.tempPath.localeCompare(right.tempPath));
        resolve({ ...fields, files });
      } catch (error) {
        reject(error);
      }
    });
    req.pipe(parser);
  });
}
