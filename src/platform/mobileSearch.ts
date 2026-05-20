import type { AppSnapshot } from "@/services/apiClient";
import type { Photo } from "@/domain/models";
import { readNativeVectorIndex } from "@/platform/nativeRepository";
import type { MobileEmbeddingResult } from "@/platform/mobileAiRuntime";
import { cosine } from "../../shared/domain/vector-math.mjs";
import { buildSearchResults } from "../../shared/search/search-core.mjs";

export async function searchMobilePhotos({
  state,
  query,
  filters,
  embedTextQuery,
}: {
  state: AppSnapshot;
  query: string;
  filters?: { tripId?: string; placeId?: string; date?: string; tag?: string; fileName?: string };
  embedTextQuery: (input: { text: string; fileName: string }) => Promise<MobileEmbeddingResult | undefined>;
}) {
  const vectorIndex: Record<string, number[]> = await readNativeVectorIndex().catch(() => ({}));
  const queryEmbedding = await embedTextQuery({ text: query, fileName: "search-query" }).catch(() => undefined);
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
