import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const apiPort = Number(process.env.EARTH_ONLINE_PORT ?? 8787);
const apiHealthUrl = `http://127.0.0.1:${apiPort}/api/state`;
const apiCapabilitiesUrl = `http://127.0.0.1:${apiPort}/api/health/capabilities`;
const children = [];
let shuttingDown = false;

function run(name, command, args) {
  const child = spawn(command, args, { cwd: rootDir, stdio: "inherit", shell: false });
  children.push(child);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    if (code && code !== 0) {
      console.error(`${name} exited with ${code}`);
      shutdown(code);
    }
  });
}

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

async function hasRunningEarthApi() {
  try {
    const response = await fetch(apiHealthUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function runningEarthApiHasCurrentCapabilities() {
  try {
    const response = await fetch(apiCapabilitiesUrl);
    if (!response.ok) return false;
    const capabilities = await response.json();
    return capabilities?.embeddingRebuildJobs === true;
  } catch {
    return false;
  }
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (await hasRunningEarthApi()) {
  if (!(await runningEarthApiHasCurrentCapabilities())) {
    console.error(`Earth_Online API is already running at ${apiHealthUrl}, but it is missing current backend capabilities. Stop that process and rerun npm run dev.`);
    process.exit(1);
  }
  console.log(`Earth_Online API already running at ${apiHealthUrl}; reusing it.`);
} else {
  run("api", process.execPath, ["server/index.mjs"]);
}
run("vite", process.execPath, [viteBin, ...process.argv.slice(2)]);
