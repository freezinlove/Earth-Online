import { embeddingSpaceId, preferredEmbeddingDimensions } from "./ai-config.mjs";
import { validateMissingInfoInferenceResult, validatePhotoAnalysisResult } from "./ai-schemas.mjs";
import { importPipelineConfig, timeoutSignal } from "../application/import-pipeline.mjs";
import { geoContextFor, localizedGeoHint, normalizeLocale } from "../domain/geo.mjs";
import { normalizeTags } from "../domain/text-normalizer.mjs";

export function providerCredentialKey(providerId) {
  if (providerId === "aliyun" || providerId === "qwen") return "aliyunApiKey";
  if (providerId === "openai") return "openaiApiKey";
  if (providerId === "openrouter") return "openrouterApiKey";
  if (providerId === "siliconflow") return "siliconflowApiKey";
  if (providerId === "voyage") return "voyageApiKey";
  return undefined;
}

export function parseJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
    if (Array.isArray(direct)) return direct.find((item) => item && typeof item === "object" && !Array.isArray(item));
  } catch {
    // Extract the first JSON object below.
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function wait(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function fetchErrorDetail(error) {
  const message = error instanceof Error ? error.message : String(error || "fetch failed");
  const cause = error instanceof Error ? error.cause : undefined;
  const causeCode = typeof cause?.code === "string" ? cause.code : undefined;
  const causeName = typeof cause?.name === "string" ? cause.name : undefined;
  const causeMessage = typeof cause?.message === "string" ? cause.message : undefined;
  const detail = [causeCode, causeName, causeMessage].filter(Boolean).join(": ");
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

function normalizeFetchError(error) {
  if (!(error instanceof Error)) return new Error(fetchErrorDetail(error));
  const normalized = new Error(fetchErrorDetail(error));
  normalized.name = error.name;
  normalized.cause = error.cause;
  return normalized;
}

function isRetryableFetchError(error) {
  const message = fetchErrorDetail(error);
  const name = error instanceof Error ? error.name : "";
  if (/abort|timeout/i.test(`${name} ${message}`)) return false;
  return /fetch failed|network|socket|connection|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR/i.test(message);
}

async function fetchWithTransportRetry(fetchImpl, url, createOptions, { attempts = 3, baseDelayMs = 200 } = {}) {
  let latestError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchImpl(url, createOptions());
    } catch (error) {
      latestError = error;
      if (attempt >= attempts || !isRetryableFetchError(error)) throw normalizeFetchError(error);
      await wait(baseDelayMs * attempt);
    }
  }
  throw normalizeFetchError(latestError);
}

export async function postJson({ fetchImpl = globalThis.fetch, url, apiKey, body, headers = {}, timeoutMs = importPipelineConfig().timeouts.aiRequestMs } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchWithTransportRetry(fetchImpl, url, () => ({
    method: "POST",
    signal: timeoutSignal(timeoutMs),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  }));
  const json = await response.json().catch(() => undefined);
  if (!response.ok || json?.error) throw new Error(json?.error?.message || json?.message || `AI request failed: ${response.status}`);
  return json;
}

export function responseHeadersToObject(headers) {
  return Object.fromEntries(headers?.entries?.() ?? []);
}

export function extractMessageText(content) {
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

export function supportsEnableThinkingControl(providerId, model) {
  const provider = String(providerId ?? "").toLowerCase();
  const modelId = String(model ?? "").toLowerCase();
  if (!["aliyun", "qwen", "siliconflow"].includes(provider)) return false;
  return /qwen|qwq|deepseek|glm|kimi/.test(modelId);
}

export function openRouterReasoningOptions({ model, enableThinking = false, thinkingBudget } = {}) {
  const modelId = String(model ?? "").toLowerCase();
  if (!modelId) return {};
  const isGemini = modelId.startsWith("google/gemini-");
  const supportsReasoningControl = isGemini || /qwen|gpt-mini|openai\/gpt/.test(modelId);
  if (!supportsReasoningControl) return {};

  if (enableThinking === true) {
    const budget = Number(thinkingBudget);
    if (Number.isFinite(budget) && budget > 0) return { reasoning: { max_tokens: Math.floor(budget) } };
    return { reasoning: { effort: "low" } };
  }

  return { reasoning: { effort: isGemini ? "minimal" : "none" } };
}

export function chatCompletionThinkingOptions({ providerId, model, enableThinking = false, thinkingBudget } = {}) {
  if (String(providerId ?? "").toLowerCase() === "openrouter") return openRouterReasoningOptions({ model, enableThinking, thinkingBudget });
  if (!supportsEnableThinkingControl(providerId, model)) return {};
  const options = { enable_thinking: enableThinking === true };
  const budget = Number(thinkingBudget);
  if (options.enable_thinking && Number.isFinite(budget) && budget > 0) options.thinking_budget = Math.floor(budget);
  return options;
}

export function chatCompletionRequestBody({ providerId, model, messages, responseFormat = { type: "json_object" }, temperature = 0.2, enableThinking = false, thinkingBudget } = {}) {
  return {
    model,
    response_format: responseFormat,
    messages,
    temperature,
    ...chatCompletionThinkingOptions({ providerId, model, enableThinking, thinkingBudget }),
  };
}

export async function chatCompletionWithProvider({
  fetchImpl = globalThis.fetch,
  providerId,
  client = "openai-compatible",
  apiKey,
  baseUrl,
  model,
  messages,
  responseFormat = { type: "json_object" },
  temperature = 0.2,
  enableThinking = false,
  thinkingBudget,
  headers = {},
  timeoutMs = importPipelineConfig().timeouts.aiRequestMs,
  debugContext,
  onDebugRecord,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  if (!apiKey) throw new Error("missing API key");
  if (!model) throw new Error("missing model id");
  if (!baseUrl) throw new Error(`missing chat completion base URL for ${providerId ?? "provider"}`);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetchWithTransportRetry(fetchImpl, endpoint, () => ({
    method: "POST",
    signal: timeoutSignal(timeoutMs),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(chatCompletionRequestBody({ providerId, model, messages, responseFormat, temperature, enableThinking, thinkingBudget })),
  }));
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
  await onDebugRecord?.({
    timestamp: new Date().toISOString(),
    client,
    operation: "chat.completions",
    endpoint,
    model,
    status: response.status,
    ok: response.ok,
    headers: responseHeaders,
    json,
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

export function multimodalEmbeddingContent({ dataUrl, text, fileName } = {}) {
  if (dataUrl) return { image: dataUrl };
  return { text: text || fileName || "" };
}

export function multimodalEmbeddingRequestDimension(model, dimensions) {
  const modelId = String(model ?? "");
  if (/^tongyi-embedding-vision-(plus|flash)$/i.test(modelId)) return undefined;
  if (modelId === "multimodal-embedding-v1") return undefined;
  return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

export function multimodalEmbeddingRequestBody({ model, dataUrl, text, fileName, dimensions } = {}) {
  const dimension = multimodalEmbeddingRequestDimension(model, dimensions);
  const body = {
    model,
    input: {
      contents: [multimodalEmbeddingContent({ dataUrl, text, fileName })],
    },
  };
  if (dimension) body.parameters = { dimension };
  return body;
}

export function openAiCompatibleEmbeddingInput({ providerId, dataUrl, text, fileName } = {}) {
  if (providerId === "siliconflow" && dataUrl) return { image: dataUrl };
  if (providerId === "openrouter" && dataUrl) {
    return [
      {
        content: [{ type: "image_url", image_url: { url: dataUrl } }],
      },
    ];
  }
  return dataUrl || text || fileName || "";
}

export function openAiCompatibleEmbeddingDimensions({ providerId, model, dimensions } = {}) {
  void providerId;
  void model;
  return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

export function openAiCompatibleEmbeddingRequestBody({ providerId, model, input, dataUrl, text, fileName, dimensions } = {}) {
  const effectiveDimensions = openAiCompatibleEmbeddingDimensions({ providerId, model, dimensions });
  const body = {
    model,
    input: input ?? openAiCompatibleEmbeddingInput({ providerId, dataUrl, text, fileName }),
  };
  if (effectiveDimensions) body.dimensions = effectiveDimensions;
  return body;
}

export function voyageEmbeddingRequestBody({ model, dataUrl, text, fileName } = {}) {
  return {
    model,
    inputs: [
      {
        content: dataUrl ? [{ type: "image_base64", image_base64: dataUrl }] : [{ type: "text", text: text || fileName || "" }],
      },
    ],
  };
}

export function fallbackPhotoAnalysis({ fileName, preset, locale = "zh" } = {}) {
  const english = normalizeLocale(locale) === "en";
  const title = english
    ? preset?.city && !preset.city.includes("待确认")
      ? `${localizedGeoHint(preset.city, "en")} memory`
      : String(fileName ?? "").replace(/\.[^.]+$/, "")
    : preset?.city && !preset.city.includes("待确认")
      ? `${preset.city}记忆`
      : String(fileName ?? "").replace(/\.[^.]+$/, "");
  const tags = normalizeTags([], preset);
  return {
    provider: "mobile-fallback",
    promptId: "photo-analysis",
    promptVersion: "1.0.0",
    title,
    tags,
    caption: english
      ? `A travel photo near ${localizedGeoHint(preset?.city ?? "an unknown place", "en")}; cloud AI can refine the scene details later.`
      : `${preset?.city ?? "未知地点"}附近的旅行照片，系统已根据 GPS/文件名地点线索生成搜索标签，画面细节需要云端 AI 进一步确认。`,
    visiblePlaceNames: [],
    locationCandidates: [],
    uncertainties: [],
    fallbackReason: undefined,
  };
}

export function chatCompletionsBaseUrl(providerId) {
  if (providerId === "aliyun" || providerId === "qwen") return "https://dashscope.aliyuncs.com/compatible-mode/v1";
  if (providerId === "siliconflow") return "https://api.siliconflow.cn/v1";
  if (providerId === "openrouter") return "https://openrouter.ai/api/v1";
  if (providerId === "openai") return "https://api.openai.com/v1";
  return undefined;
}

export function providerHeaders(providerId) {
  return providerId === "openrouter" ? { "HTTP-Referer": "https://earth-online.local", "X-Title": "Earth Online" } : {};
}

function normalizedPrompt(prompt, fallbackContent, locale = "zh") {
  return {
    id: prompt?.id,
    version: prompt?.version,
    locale: normalizeLocale(prompt?.locale ?? locale),
    content: prompt?.content ?? fallbackContent,
  };
}

function requireSharedPrompt(prompt, promptName, locale = "zh") {
  const normalized = normalizedPrompt(prompt, undefined, locale);
  if (!normalized.content) throw new Error(`Missing shared AI prompt: ${promptName}`);
  return normalized;
}

export function photoAnalysisMessages({ prompt, preset, geoContext, dataUrl, mime = "image/jpeg", location, locale = "zh" } = {}) {
  const exif = geoContext ?? (preset ? geoContextFor(preset, location, locale) : { hasGps: false, cityHint: "待确认", countryHint: "待确认" });
  return [
    { role: "system", content: prompt.content },
    {
      role: "user",
      content: [
        { type: "text", text: JSON.stringify({ exif }) },
        { type: "image_url", image_url: { url: dataUrl || `data:${mime};base64,` } },
      ],
    },
  ];
}

export function photoAnalysisFromContent({ content, prompt, preset, providerId, modelId } = {}) {
  return {
    ...validatePhotoAnalysisResult(parseJsonObject(content), prompt.locale === "en" ? undefined : preset, { locale: prompt.locale }),
    provider: providerId,
    model: modelId,
    promptId: prompt.id ?? "photo-analysis",
    promptVersion: prompt.version ?? "1.0.0",
  };
}

export function missingInfoUserInstruction(locale = "zh") {
  return normalizeLocale(locale) === "en"
    ? "Use the current missing-GPS photo image and the strictly sectioned JSON data below. Output one second-pass missing-information inference JSON."
    : "请根据当前待补照片图像和下方严格分区的 JSON 数据，输出一个待补信息二次推断 JSON。";
}

export function missingInfoMessages({ prompt, inferenceInput, dataUrl, mime = "image/jpeg" } = {}) {
  return [
    { role: "system", content: prompt.content },
    {
      role: "user",
      content: [
        { type: "text", text: [missingInfoUserInstruction(prompt.locale), JSON.stringify(inferenceInput)].join("\n\n") },
        { type: "image_url", image_url: { url: dataUrl || `data:${mime};base64,` } },
      ],
    },
  ];
}

export function missingInfoFromContent({ content, prompt, providerId, modelId } = {}) {
  return {
    ...validateMissingInfoInferenceResult(parseJsonObject(content), { locale: prompt.locale }),
    provider: providerId,
    model: modelId,
    promptId: prompt.id ?? "missing-info-inference",
    promptVersion: prompt.version ?? "1.0.0",
  };
}

export async function analyzePhotoWithProviderCore({
  fetchImpl = globalThis.fetch,
  profile,
  providerId = profile?.providerId,
  apiKey,
  baseUrl = chatCompletionsBaseUrl(providerId),
  modelId = profile?.modelId,
  prompt,
  fileName,
  mime = "image/jpeg",
  dataUrl,
  preset,
  geoContext,
  location,
  locale = "zh",
  headers = providerHeaders(providerId),
  debugContext,
  onDebugRecord,
} = {}) {
  const normalized = requireSharedPrompt(prompt, "photoAnalysis", locale);
  const content = await chatCompletionWithProvider({
    fetchImpl,
    providerId,
    client: providerId === "aliyun" || providerId === "qwen" ? "qwen-compatible" : "openai-compatible",
    apiKey,
    baseUrl,
    model: modelId,
    messages: photoAnalysisMessages({ prompt: normalized, preset, geoContext, dataUrl, mime, location, locale: normalized.locale }),
    temperature: 0.2,
    headers,
    debugContext,
    onDebugRecord,
  });
  return photoAnalysisFromContent({ content, prompt: normalized, preset, providerId, modelId });
}

export async function analyzePhotoWithProvider({
  fetchImpl = globalThis.fetch,
  profile,
  apiKey,
  fileName,
  mime = "image/jpeg",
  dataUrl,
  preset,
  location,
  allowCloud = true,
  locale = "zh",
  prompt,
} = {}) {
  const fallback = fallbackPhotoAnalysis({ fileName, preset, locale });
  if (!allowCloud || !profile?.providerId || !profile?.modelId || !apiKey) return fallback;
  try {
    return await analyzePhotoWithProviderCore({
      fetchImpl,
      profile,
      apiKey,
      fileName,
      mime,
      dataUrl,
      preset,
      location,
      locale,
      prompt,
    });
  } catch (error) {
    return {
      ...fallback,
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inferMissingInfoWithProviderCore({
  fetchImpl = globalThis.fetch,
  profile,
  providerId = profile?.providerId,
  apiKey,
  baseUrl = chatCompletionsBaseUrl(providerId),
  modelId = profile?.modelId,
  prompt,
  dataUrl,
  mime = "image/jpeg",
  inferenceInput,
  locale = "zh",
  headers = providerHeaders(providerId),
  debugContext,
  onDebugRecord,
} = {}) {
  const normalized = requireSharedPrompt(prompt, "missingInfoInference", locale);
  const content = await chatCompletionWithProvider({
    fetchImpl,
    providerId,
    client: providerId === "aliyun" || providerId === "qwen" ? "qwen-compatible" : "openai-compatible",
    apiKey,
    baseUrl,
    model: modelId,
    messages: missingInfoMessages({ prompt: normalized, inferenceInput, dataUrl, mime }),
    temperature: 0.1,
    headers,
    debugContext,
    onDebugRecord,
  });
  return missingInfoFromContent({ content, prompt: normalized, providerId, modelId });
}

export async function inferMissingInfoWithProvider({
  fetchImpl = globalThis.fetch,
  profile,
  apiKey,
  dataUrl,
  mime = "image/jpeg",
  inferenceInput,
  locale = "zh",
  prompt,
} = {}) {
  if (!profile?.providerId || !profile?.modelId || !apiKey) return validateMissingInfoInferenceResult(undefined, { locale });
  if (!chatCompletionsBaseUrl(profile.providerId)) return validateMissingInfoInferenceResult(undefined, { locale });
  return inferMissingInfoWithProviderCore({
    fetchImpl,
    profile,
    apiKey,
    dataUrl,
    mime,
    inferenceInput,
    locale,
    prompt,
  });
}

export async function embedContentWithProvider({
  fetchImpl = globalThis.fetch,
  profile,
  providerId = profile?.providerId,
  modelId = profile?.modelId,
  apiKey,
  baseUrl,
  headers,
  dimensions: requestedDimensions,
  input,
  dataUrl,
  text,
  fileName,
  allowCloud = true,
  timeoutMs = importPipelineConfig().timeouts.aiRequestMs,
} = {}) {
  const effectiveProfile = { ...(profile ?? {}), enabled: profile?.enabled ?? true, providerId, modelId };
  if (!allowCloud || !effectiveProfile.enabled || !effectiveProfile.providerId || !effectiveProfile.modelId || !apiKey) return undefined;
  const dimensions = Number.isInteger(requestedDimensions) && requestedDimensions > 0 ? requestedDimensions : preferredEmbeddingDimensions(effectiveProfile);
  const spaceId = embeddingSpaceId(effectiveProfile);

  if (effectiveProfile.providerId === "aliyun" || effectiveProfile.providerId === "qwen") {
    const json = await postJson({
      fetchImpl,
      url: "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
      apiKey,
      body: multimodalEmbeddingRequestBody({ model: effectiveProfile.modelId, dataUrl, text, fileName, dimensions }),
      timeoutMs,
    });
    const embedding = json?.output?.embeddings?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("embedding returned unexpected content");
    return embeddingProviderResult({ embedding, embeddingProvider: effectiveProfile.providerId, embeddingModel: effectiveProfile.modelId, profile: effectiveProfile, spaceId });
  }

  if (effectiveProfile.providerId === "siliconflow" || effectiveProfile.providerId === "openrouter" || effectiveProfile.providerId === "openai") {
    const resolvedBaseUrl =
      baseUrl ??
      (effectiveProfile.providerId === "siliconflow"
        ? "https://api.siliconflow.cn/v1"
        : effectiveProfile.providerId === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : "https://api.openai.com/v1");
    const json = await postJson({
      fetchImpl,
      url: `${resolvedBaseUrl.replace(/\/$/, "")}/embeddings`,
      apiKey,
      body: openAiCompatibleEmbeddingRequestBody({ providerId: effectiveProfile.providerId, model: effectiveProfile.modelId, input, dataUrl, text, fileName, dimensions }),
      headers: headers ?? providerHeaders(effectiveProfile.providerId),
      timeoutMs,
    });
    const embedding = json?.data?.[0]?.embedding ?? json?.output?.embeddings?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("embedding returned unexpected content");
    return embeddingProviderResult({ embedding, embeddingProvider: effectiveProfile.providerId, embeddingModel: effectiveProfile.modelId, profile: effectiveProfile, spaceId });
  }

  if (effectiveProfile.providerId === "voyage") {
    const json = await postJson({
      fetchImpl,
      url: "https://api.voyageai.com/v1/multimodalembeddings",
      apiKey,
      body: voyageEmbeddingRequestBody({ model: effectiveProfile.modelId, dataUrl, text, fileName }),
      timeoutMs,
    });
    const embedding = json?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("embedding returned unexpected content");
    return embeddingProviderResult({ embedding, embeddingProvider: effectiveProfile.providerId, embeddingModel: effectiveProfile.modelId, profile: effectiveProfile, spaceId });
  }

  return undefined;
}

export function embeddingProviderResult({ embedding, embeddingProvider, embeddingModel, profile, spaceId = embeddingSpaceId(profile) }) {
  const normalized = embedding.map(Number);
  const expectedDimension = preferredEmbeddingDimensions(profile);
  if (Number.isInteger(expectedDimension) && expectedDimension > 0 && normalized.length !== expectedDimension) {
    throw new Error(`embedding dimension mismatch: expected ${expectedDimension}, got ${normalized.length}`);
  }
  return {
    embedding: normalized,
    embeddingProvider,
    embeddingModel,
    embeddingSpaceId: spaceId,
    embeddingDimension: normalized.length,
    embeddingMode: "cross_modal",
  };
}
