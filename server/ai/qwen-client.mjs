import { envValue } from "../config/env.mjs";
import { collectRequestIds, emitAiDebugRecord, responseHeadersToObject } from "./ai-debug.mjs";

const qwenCompatibleBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const qwenMultimodalEmbeddingUrl =
  "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
const qwenRequestTimeoutMs = 80000;

function requestSignal(rootDir) {
  const timeout = Number(envValue(rootDir, "QWEN_REQUEST_TIMEOUT_MS", qwenRequestTimeoutMs));
  return globalThis.AbortSignal.timeout(Number.isFinite(timeout) && timeout > 0 ? timeout : qwenRequestTimeoutMs);
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

export async function qwenChatCompletion({
  apiKey,
  rootDir = process.cwd(),
  model = envValue(rootDir, "QWEN_CHAT_MODEL", "qwen3.5-flash"),
  messages,
  responseFormat = { type: "json_object" },
  temperature = 0.2,
  debugContext,
}) {
  if (!apiKey) throw new Error("missing Qwen API key");

  const endpoint = `${qwenCompatibleBaseUrl}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    signal: requestSignal(rootDir),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
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
  const headers = responseHeadersToObject(response.headers);
  const content = extractMessageText(json?.choices?.[0]?.message?.content);
  await emitAiDebugRecord({
    timestamp: new Date().toISOString(),
    client: "qwen-compatible",
    operation: "chat.completions",
    endpoint,
    model,
    status: response.status,
    ok: response.ok,
    requestIds: collectRequestIds({ headers, json }),
    headers,
    jsonParseError,
    contentLength: content.length,
    contentTrimmedLength: content.trim().length,
    rawResponse,
    debugContext,
  });
  if (!response.ok) throw new Error(`qwen chat failed: ${response.status}`);
  if (jsonParseError) throw new Error(`qwen chat returned invalid JSON response: ${jsonParseError}`);
  if (content.trim()) return content;
  const upstreamMessage = json?.error?.message || json?.message || json?.choices?.[0]?.finish_reason;
  throw new Error(`qwen chat returned empty content${upstreamMessage ? `: ${upstreamMessage}` : ""}`);
}

export async function qwenMultimodalEmbedding({
  apiKey,
  rootDir = process.cwd(),
  model = envValue(rootDir, "QWEN_VISION_EMBEDDING_MODEL", "tongyi-embedding-vision-flash-2026-03-06"),
  fileName,
  dataUrl,
  text,
  dimension,
}) {
  if (!apiKey) throw new Error("missing Qwen API key");

  const response = await fetch(qwenMultimodalEmbeddingUrl, {
    method: "POST",
    signal: requestSignal(rootDir),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: {
        contents: [
          dataUrl
            ? { image: dataUrl }
            : {
                text: text || fileName,
              },
        ],
      },
      parameters: Number.isInteger(dimension) && dimension > 0 ? { dimension } : {},
    }),
  });
  if (!response.ok) throw new Error(`qwen embedding failed: ${response.status}`);

  const json = await response.json();
  const embedding = json.output?.embeddings?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("qwen embedding returned unexpected content");
  return embedding.map(Number);
}
