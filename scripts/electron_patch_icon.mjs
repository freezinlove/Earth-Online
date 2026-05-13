import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rceditPath = path.join(rootDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
const exePath = path.join(rootDir, "release", "win-unpacked", "Earth Online.exe");
const iconPath = path.join(rootDir, "docs", "gugugaga.ico");

for (const filePath of [rceditPath, exePath, iconPath]) {
  if (!existsSync(filePath)) throw new Error(`Required file not found: ${filePath}`);
}

await new Promise((resolve, reject) => {
  execFile(rceditPath, [exePath, "--set-icon", iconPath], { cwd: rootDir }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
      return;
    }
    resolve();
  });
});

console.log(`Patched Windows executable icon: ${exePath}`);
