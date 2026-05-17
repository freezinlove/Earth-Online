import type { AppSnapshot } from "@/services/apiClient";
import type { Photo } from "@/domain/models";
import { readNativeVectorIndex } from "@/platform/nativeRepository";
import type { MobileEmbeddingResult } from "@/platform/mobileAiRuntime";
import { buildSearchResults } from "../../shared/search/search-core.mjs";

function cosine(left: number[], right: number[]) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm && rightNorm ? dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) : 0;
}

export async function searchMobilePhotos({
  state,
  query,
  filters,
  embedContent,
}: {
  state: AppSnapshot;
  query: string;
  filters?: { tripId?: string; placeId?: string; date?: string; tag?: string; fileName?: string };
  embedContent: (input: { text: string; fileName: string }) => Promise<MobileEmbeddingResult | undefined>;
}) {
  const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
  const queryEmbedding = await embedContent({ text: query, fileName: "search-query" }).catch(() => undefined);
  const queryVector = queryEmbedding?.embedding;
  const querySpaceId = queryEmbedding?.embeddingSpaceId;
  const results = buildSearchResults({
    documents: state.searchDocuments ?? [],
    photos: state.photos,
    query,
    filters,
    vectorScoreForDocument: (document: { photoId: string }, photo: Photo) => {
      const vector = vectorIndex[document.photoId];
      const canUseVector =
        Array.isArray(queryVector) &&
        Array.isArray(vector) &&
        querySpaceId &&
        photo?.embeddingMode === "cross_modal" &&
        photo.embeddingSpaceId === querySpaceId;
      return canUseVector ? (cosine(queryVector, vector) + 1) / 2 : 0;
    },
  });
  return { results };
}
