import { readProviderApiKey } from "../embedding-service.mjs";

function requestSignal() {
  return globalThis.AbortSignal.timeout(80000);
}

function voyageInput({ dataUrl, text }) {
  if (dataUrl) {
    return [
      {
        content: [
          { type: "image_base64", image_base64: dataUrl },
        ],
      },
    ];
  }
  return [
    {
      content: [
        { type: "text", text: text ?? "" },
      ],
    },
  ];
}

export const voyageProvider = {
  id: "voyage",
  displayName: "Voyage",
  capabilities: {
    imageUnderstanding: false,
    crossModalEmbedding: true,
    imageAnalysis: false,
    missingInfoInference: false,
    embedding: true,
  },
  async embed({ rootDir, secretProvider, dataUrl, text, modelId }) {
    const apiKey = readProviderApiKey("voyage", rootDir, secretProvider);
    if (!apiKey) throw new Error("missing Voyage API key");
    if (!modelId) throw new Error("missing Voyage model id");
    const response = await fetch("https://api.voyageai.com/v1/multimodalembeddings", {
      method: "POST",
      signal: requestSignal(),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        inputs: voyageInput({ dataUrl, text }),
      }),
    });
    if (!response.ok) throw new Error(`voyage embedding failed: ${response.status}`);
    const json = await response.json();
    const embedding = json.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("voyage embedding returned unexpected content");
    return {
      embedding: embedding.map(Number),
      embeddingProvider: this.id,
      embeddingModel: modelId,
    };
  },
};
