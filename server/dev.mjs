import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
const children = [];

function run(name, command, args) {
  const child = spawn(command, args, { cwd: rootDir, stdio: "inherit", shell: false });
  children.push(child);
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with ${code}`);
      shutdown(code);
    }
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("api", process.execPath, ["server/index.mjs"]);
run("vite", process.execPath, [viteBin, ...process.argv.slice(2)]);
