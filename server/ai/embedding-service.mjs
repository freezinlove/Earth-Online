import { envValue } from "../config/env.mjs";

export function readQwenChatApiKey(rootDir = process.cwd(), secretProvider) {
  return secretProvider?.get("qwenChatApiKey") ?? envValue(rootDir, "QWEN_CHAT_API_KEY", envValue(rootDir, "QWEN_API_KEY"));
}

export function readQwenEmbeddingApiKey(rootDir = process.cwd(), secretProvider) {
  return secretProvider?.get("qwenEmbeddingApiKey") ?? envValue(rootDir, "QWEN_EMBEDDING_API_KEY", envValue(rootDir, "QWEN_API_KEY"));
}
