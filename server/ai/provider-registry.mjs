import { qwenProvider } from "./providers/qwen-provider.mjs";

const providers = new Map();

const defaultProviderByCapability = {
  embedding: "qwen",
  imageAnalysis: "qwen",
};

export function registerAiProvider(provider) {
  if (!provider?.id) throw new Error("AI provider must include an id");
  providers.set(provider.id, provider);
}

export function getAiProvider(capability, preferredProviderId) {
  const providerId = preferredProviderId ?? defaultProviderByCapability[capability];
  const preferred = providers.get(providerId);
  if (preferred?.capabilities?.[capability]) return preferred;
  return Array.from(providers.values()).find((provider) => provider.capabilities?.[capability]);
}

export function listAiProviders() {
  return Array.from(providers.values()).map(({ id, displayName, capabilities }) => ({ id, displayName, capabilities }));
}

registerAiProvider(qwenProvider);
