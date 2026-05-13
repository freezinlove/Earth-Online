import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const devServerUrl = process.env.ELECTRON_DEV_SERVER_URL ?? "http://127.0.0.1:5173/";
const apiPort = process.env.EARTH_ONLINE_PORT ?? "8787";
const children = new Set();
let shuttingDown = false;

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...options.env },
    shell: false,
    stdio: "inherit",
  });
  children.add(child);
  child.on("exit", (code) => {
    children.delete(child);
    if (!shuttingDown && code && code !== 0) shutdown(code);
  });
  return child;
}

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

async function waitForUrl(url, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
await waitForUrl(devServerUrl);

const { default: electronPath } = await import("electron");
const electronProcess = run(electronPath, [rootDir], {
  env: {
    EARTH_ONLINE_PORT: apiPort,
    ELECTRON_DEV_SERVER_URL: devServerUrl,
  },
});
electronProcess.on("exit", (code) => shutdown(code ?? 0));
