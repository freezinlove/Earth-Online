import { envValue } from "../config/env.mjs";
import { collectRequestIds, emitAiDebugRecord } from "./ai-debug.mjs";
import { chatCompletionWithProvider, embedContentWithProvider } from "../../shared/ai/provider-runtime.mjs";

const defaultTimeoutMs = 80000;

function requestTimeoutMs(rootDir, timeoutEnvKey) {
  const timeout = Number(envValue(rootDir, timeoutEnvKey, defaultTimeoutMs));
  return Number.isFinite(timeout) && timeout > 0 ? timeout : defaultTimeoutMs;
}

async function emitProviderDebugRecord(record) {
  const { json, ...debugRecord } = record;
  await emitAiDebugRecord({
    ...debugRecord,
    requestIds: collectRequestIds({ headers: debugRecord.headers, json }),
  });
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
  return chatCompletionWithProvider({
    client: "openai-compatible",
    apiKey,
    baseUrl,
    model,
    messages,
    responseFormat,
    temperature,
    headers,
    timeoutMs: requestTimeoutMs(rootDir, timeoutEnvKey),
    debugContext,
    onDebugRecord: emitProviderDebugRecord,
  });
}

export async function openAiCompatibleEmbedding({
  apiKey,
  baseUrl,
  rootDir = process.cwd(),
  timeoutEnvKey = "AI_REQUEST_TIMEOUT_MS",
  providerId,
  model,
  input,
  dataUrl,
  text,
  fileName,
  dimensions,
  headers = {},
}) {
  const result = await embedContentWithProvider({
    profile: { enabled: true, providerId, modelId: model, modelSource: "custom" },
    apiKey,
    baseUrl,
    headers,
    input,
    dataUrl,
    text,
    fileName,
    dimensions,
    timeoutMs: requestTimeoutMs(rootDir, timeoutEnvKey),
  });
  if (!result) throw new Error("embedding unavailable");
  return result.embedding;
}
