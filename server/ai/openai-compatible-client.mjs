import { envValue } from "../config/env.mjs";
import { collectRequestIds, emitAiDebugRecord, responseHeadersToObject } from "./ai-debug.mjs";

const defaultTimeoutMs = 80000;

function requestSignal(rootDir, timeoutEnvKey) {
  const timeout = Number(envValue(rootDir, timeoutEnvKey, defaultTimeoutMs));
  return globalThis.AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? timeout : defaultTimeoutMs);
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        if (Array.isArray(part?.content)) return extractMessageText(part.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  if (typeof content?.content === "string") return content.content;
  return "";
}

export async function openAiCompatibleChatCompletion({
  apiKey,
  baseUrl,
  rootDir = process.cwd(),
  timeoutEnvKey = "AI_REQUEST_TIMEOUT_MS",
  model,
  messages,
  responseFormat = { type: "json_object" },
  temperature = 0.2,
  headers = {},
  debugContext,
}) {
  if (!apiKey) throw new Error("missing API key");
  if (!model) throw new Error("missing model id");
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    signal: requestSignal(rootDir, timeoutEnvKey),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      model,
      response_format: responseFormat,
      messages,
      temperature,
    }),
  });
  const rawResponse = await response.text();
  let json;
  let jsonParseError;
  try {
    json = rawResponse ? JSON.parse(rawResponse) : undefined;
  } catch (error) {
    jsonParseError = error instanceof Error ? error.message : String(error);
  }
  const responseHeaders = responseHeadersToObject(response.headers);
  const upstreamMessage = json?.error?.message || json?.message || json?.choices?.[0]?.finish_reason;
  const content = extractMessageText(json?.choices?.[0]?.message?.content);
  await emitAiDebugRecord({
    timestamp: new Date().toISOString(),
    client: "openai-compatible",
    operation: "chat.completions",
    endpoint,
    model,
    status: response.status,
    ok: response.ok,
    requestIds: collectRequestIds({ headers: responseHeaders, json }),
    headers: responseHeaders,
    jsonParseError,
    contentLength: content.length,
    contentTrimmedLength: content.trim().length,
    rawResponse,
    debugContext,
  });
  if (jsonParseError) throw new Error(`chat completion returned invalid JSON response: ${jsonParseError}`);
  if (!response.ok || json?.error) throw new Error(`chat completion failed: ${json?.error?.code ?? response.status}${upstreamMessage ? `: ${upstreamMessage}` : ""}`);
  if (content.trim()) return content;
  throw new Error(`chat completion returned empty content${upstreamMessage ? `: ${upstreamMessage}` : ""}`);
}

export async function openAiCompatibleEmbedding({
  apiKey,
  baseUrl,
  rootDir = process.cwd(),
  timeoutEnvKey = "AI_REQUEST_TIMEOUT_MS",
  model,
  input,
  dimensions,
  headers = {},
}) {
  if (!apiKey) throw new Error("missing API key");
  if (!model) throw new Error("missing model id");
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    signal: requestSignal(rootDir, timeoutEnvKey),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      model,
      input,
      ...(Number.isInteger(dimensions) && dimensions > 0 ? { dimensions } : {}),
    }),
  });
  const json = await response.json();
  const upstreamMessage = json.error?.message || json.message;
  if (!response.ok || json.error) throw new Error(`embedding failed: ${json.error?.code ?? response.status}${upstreamMessage ? `: ${upstreamMessage}` : ""}`);
  const embedding = json.data?.[0]?.embedding ?? json.output?.embeddings?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("embedding returned unexpected content");
  return embedding.map(Number);
}
