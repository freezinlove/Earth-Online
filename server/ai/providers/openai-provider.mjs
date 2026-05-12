import { createOpenAiCompatibleProvider } from "./openai-compatible-provider.mjs";

export const openaiProvider = createOpenAiCompatibleProvider({
  id: "openai",
  displayName: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  supportsEmbedding: false,
});
