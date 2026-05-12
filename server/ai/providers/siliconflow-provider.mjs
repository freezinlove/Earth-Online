import { createOpenAiCompatibleProvider } from "./openai-compatible-provider.mjs";

export const siliconflowProvider = createOpenAiCompatibleProvider({
  id: "siliconflow",
  displayName: "硅基流动",
  baseUrl: "https://api.siliconflow.cn/v1",
  supportsEmbedding: true,
});
