import { envValue } from "../config/env.mjs";
import { collectRequestIds, emitAiDebugRecord } from "./ai-debug.mjs";
import { chatCompletionWithProvider, embedContentWithProvider } from "../../shared/ai/provider-runtime.mjs";

const qwenCompatibleBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const qwenRequestTimeoutMs = 80000;

function requestTimeoutMs(rootDir) {
  const timeout = Number(envValue(rootDir, "QWEN_REQUEST_TIMEOUT_MS", qwenRequestTimeoutMs));
  return Number.isFinite(timeout) && timeout > 0 ? timeout : qwenRequestTimeoutMs;
}

async function emitProviderDebugRecord(record) {
  const { json, ...debugRecord } = record;
  await emitAiDebugRecord({
    ...debugRecord,
    requestIds: collectRequestIds({ headers: debugRecord.headers, json }),
  });
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
  return chatCompletionWithProvider({
    client: "qwen-compatible",
    providerId: "aliyun",
    apiKey,
    baseUrl: qwenCompatibleBaseUrl,
    model,
    messages,
    responseFormat,
    temperature,
    timeoutMs: requestTimeoutMs(rootDir),
    debugContext,
    onDebugRecord: emitProviderDebugRecord,
  });
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
  const result = await embedContentWithProvider({
    profile: { enabled: true, providerId: "qwen", modelId: model, modelSource: "custom" },
    apiKey,
    fileName,
    dataUrl,
    text,
    dimensions: dimension,
    timeoutMs: requestTimeoutMs(rootDir),
  });
  if (!result) throw new Error("qwen embedding unavailable");
  return result.embedding;
}
