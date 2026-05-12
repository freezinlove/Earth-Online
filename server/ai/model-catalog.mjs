export const aiModelCatalog = {
  imageUnderstanding: {
    aliyun: [
      { id: "qwen3.6-flash", label: "Qwen 3.6 Flash", recommended: true },
      { id: "qwen3.5-flash", label: "Qwen 3.5 Flash", recommended: true },
    ],
    siliconflow: [
      { id: "Qwen/Qwen3.6-35B-A3B", label: "Qwen3.6 35B A3B", recommended: true },
      { id: "Qwen/Qwen3.5-35B-A3B", label: "Qwen3.5 35B A3B", recommended: true },
    ],
    openai: [
      { id: "gpt-4o-mini", label: "GPT-4o Mini", recommended: true },
      { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", recommended: true },
    ],
    openrouter: [
      { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", recommended: true },
      { id: "~openai/gpt-mini-latest", label: "OpenAI GPT Mini Latest", recommended: true },
      { id: "qwen/qwen3.6-flash", label: "Qwen3.6 Flash", recommended: true },
    ],
  },
  crossModalEmbedding: {
    aliyun: [
      { id: "qwen3-vl-embedding", label: "Qwen3 VL Embedding", recommended: true, dimensions: 1024 },
      { id: "tongyi-embedding-vision-plus-2026-03-06", label: "Tongyi Vision Embedding Plus", recommended: true, dimensions: 1024 },
      { id: "tongyi-embedding-vision-flash-2026-03-06", label: "Tongyi Vision Embedding Flash", recommended: true, dimensions: 768 },
    ],
    siliconflow: [
      { id: "Qwen/Qwen3-VL-Embedding-8B", label: "Qwen3 VL Embedding 8B", recommended: true, dimensions: 1024 },
    ],
    voyage: [
      { id: "voyage-multimodal-3.5", label: "Voyage Multimodal 3.5", recommended: true, dimensions: 1024 },
      { id: "voyage-multimodal-3", label: "Voyage Multimodal 3", recommended: true, dimensions: 1024 },
    ],
    openrouter: [
      { id: "google/gemini-embedding-2-preview", label: "Gemini Embedding 2 Preview", recommended: true, dimensions: 1024 },
      { id: "nvidia/llama-nemotron-embed-vl-1b-v2:free", label: "Llama Nemotron Embed VL 1B v2 Free", recommended: true, dimensions: 1024 },
    ],
  },
};

export const aiProviders = [
  { id: "aliyun", displayName: "阿里百炼", capabilities: { imageUnderstanding: true, crossModalEmbedding: true } },
  { id: "siliconflow", displayName: "硅基流动", capabilities: { imageUnderstanding: true, crossModalEmbedding: true } },
  { id: "openai", displayName: "OpenAI", capabilities: { imageUnderstanding: true, crossModalEmbedding: false } },
  { id: "openrouter", displayName: "OpenRouter", capabilities: { imageUnderstanding: true, crossModalEmbedding: true } },
  { id: "voyage", displayName: "Voyage", capabilities: { imageUnderstanding: false, crossModalEmbedding: true } },
];

export function firstRecommendedModel(profileId, providerId) {
  return aiModelCatalog[profileId]?.[providerId]?.find((model) => model.recommended)?.id;
}

export function modelEmbeddingDimensions(profileId, providerId, modelId) {
  const dimensions = aiModelCatalog[profileId]?.[providerId]?.find((model) => model.id === modelId)?.dimensions;
  return Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

export function listAiModelCatalog() {
  return {
    providers: aiProviders,
    models: aiModelCatalog,
  };
}
