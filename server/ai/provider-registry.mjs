import { openaiProvider } from "./providers/openai-provider.mjs";
import { openrouterProvider } from "./providers/openrouter-provider.mjs";
import { aliyunProvider, qwenProvider } from "./providers/qwen-provider.mjs";
import { siliconflowProvider } from "./providers/siliconflow-provider.mjs";
import { voyageProvider } from "./providers/voyage-provider.mjs";

const providers = new Map();

const defaultProviderByCapability = {
  crossModalEmbedding: "aliyun",
  embedding: "aliyun",
  imageUnderstanding: "aliyun",
  imageAnalysis: "aliyun",
  missingInfoInference: "aliyun",
};

export function registerAiProvider(provider) {
  if (!provider?.id) throw new Error("AI provider must include an id");
  providers.set(provider.id, provider);
}

export function getAiProvider(capability, preferredProviderId) {
  const providerId = preferredProviderId ?? defaultProviderByCapability[capability];
  const preferred = providers.get(providerId);
  if (preferred?.capabilities?.[capability]) return preferred;
  if (preferredProviderId) return undefined;
  return Array.from(providers.values()).find((provider) => provider.capabilities?.[capability]);
}

export function listAiProviders() {
  return Array.from(providers.values()).map(({ id, displayName, capabilities }) => ({ id, displayName, capabilities }));
}

registerAiProvider(aliyunProvider);
registerAiProvider(qwenProvider);
registerAiProvider(siliconflowProvider);
registerAiProvider(openaiProvider);
registerAiProvider(openrouterProvider);
registerAiProvider(voyageProvider);
