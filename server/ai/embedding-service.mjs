import { envValue } from "../config/env.mjs";

export function readQwenChatApiKey(rootDir = process.cwd(), secretProvider) {
  return secretProvider?.get("aliyunApiKey") ?? secretProvider?.get("qwenChatApiKey") ?? envValue(rootDir, "QWEN_CHAT_API_KEY", envValue(rootDir, "QWEN_API_KEY"));
}

export function readQwenEmbeddingApiKey(rootDir = process.cwd(), secretProvider) {
  return secretProvider?.get("aliyunApiKey") ?? secretProvider?.get("qwenEmbeddingApiKey") ?? envValue(rootDir, "QWEN_EMBEDDING_API_KEY", envValue(rootDir, "QWEN_API_KEY"));
}

export function readProviderApiKey(providerId, rootDir = process.cwd(), secretProvider) {
  const key = `${providerId}ApiKey`;
  const envKey = `${String(providerId).toUpperCase()}_API_KEY`;
  return secretProvider?.get(key) ?? envValue(rootDir, envKey, undefined);
}
