import { port } from "./config/paths.mjs";
import { startEarthOnlineApiServer } from "./create-server.mjs";

let api;

function shutdown(code = 0) {
  void api?.close().finally(() => process.exit(code));
}

try {
  api = await startEarthOnlineApiServer({ host: "127.0.0.1", port });
  console.log(`Earth_Online API listening on ${api.url}`);
} catch (error) {
  if (error?.code === "EADDRINUSE") {
    console.error(`Earth_Online API port is already in use: http://127.0.0.1:${port}`);
  } else {
    console.error(error);
  }
  process.exit(1);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
