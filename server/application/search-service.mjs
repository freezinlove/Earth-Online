import { projectState } from "../domain/state-projector.mjs";
import { cosine } from "../domain/vectors.mjs";
import { buildSearchResults } from "../../shared/search/search-core.mjs";

export function createSearchService({ readState, readVectorIndex, embedSearchQuery, rootDir, secretProvider }) {
  async function search(params) {
    const q = params.get("q") ?? "";
    const state = await readState();
    const projection = projectState(state);
    const vectorIndex = await readVectorIndex();
    const queryEmbedding = await embedSearchQuery(q, { rootDir, allowCloud: true, secretProvider });
    const queryVector = Array.isArray(queryEmbedding) ? queryEmbedding : queryEmbedding.embedding;
    const querySpaceId = Array.isArray(queryEmbedding) ? undefined : queryEmbedding.embeddingSpaceId;

    const results = buildSearchResults({
      documents: projection.searchDocuments,
      photos: state.photos,
      query: q,
      filters: {
        tripId: params.get("tripId") || undefined,
        placeId: params.get("placeId") || undefined,
        date: params.get("date") || undefined,
        tag: params.get("tag") || undefined,
      },
      vectorScoreForDocument: (document, photo) => {
        const canUseVector =
          Array.isArray(queryVector) &&
          Array.isArray(vectorIndex[document.photoId]) &&
          querySpaceId &&
          photo?.embeddingMode === "cross_modal" &&
          photo.embeddingSpaceId === querySpaceId;
        return canUseVector ? (cosine(queryVector, vectorIndex[document.photoId]) + 1) / 2 : 0;
      },
    });
    return { results };
  }

  return { search };
}
