import fs from "node:fs/promises";

const localHookUrl = new URL("./local-ai-debug.mjs", import.meta.url);

const requestIdHeaderNames = [
  "x-request-id",
  "x-acs-request-id",
  "x-dashscope-request-id",
  "dashscope-request-id",
  "x-amzn-requestid",
  "x-amzn-trace-id",
  "cf-ray",
  "traceparent",
];

let localHookPromise;

async function loadLocalHook() {
  if (!localHookPromise) {
    localHookPromise = fs
      .access(localHookUrl)
      .then(() => import(localHookUrl.href))
      .catch((error) => {
        if (error?.code !== "ENOENT") console.warn("[ai-debug] Failed to load local AI debug hook:", error);
        return undefined;
      });
  }
  return localHookPromise;
}

function getPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

export function responseHeadersToObject(headers) {
  return Object.fromEntries(headers.entries());
}

export function collectRequestIds({ headers = {}, json } = {}) {
  const ids = [];
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]));
  for (const name of requestIdHeaderNames) {
    const value = normalizedHeaders[name];
    if (value) ids.push({ source: `header:${name}`, value: String(value) });
  }
  const jsonPaths = [["request_id"], ["requestId"], ["id"], ["output", "request_id"], ["output", "requestId"]];
  for (const path of jsonPaths) {
    const value = getPath(json, path);
    if (value) ids.push({ source: `json:${path.join(".")}`, value: String(value) });
  }
  const seen = new Set();
  return ids.filter((item) => {
    const key = `${item.source}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function emitAiDebugRecord(record) {
  try {
    const hook = await loadLocalHook();
    if (typeof hook?.recordAiResponse !== "function") return;
    await hook.recordAiResponse(record);
  } catch (error) {
    console.warn("[ai-debug] Failed to write local AI debug record:", error);
  }
}
