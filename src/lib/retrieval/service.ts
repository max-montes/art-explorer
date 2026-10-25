import {
  channelOf,
  DEFAULT_CHANNEL,
  type AssetVectors,
  type Channel,
  type ScoredAsset,
  type SearchRanking,
  type SearchResult,
  type SearchWeights,
} from "@/lib/catalog/types";
import type { EmbeddingProvider } from "./providers";
import type { QueryProviderSelector } from "./model-router";
import {
  analyzeCatalogQuery,
  buildCatalogLexicon,
  type CatalogLexicon,
} from "./query-intent";
import type { CatalogRepository } from "./repository";

const IMAGE_SEARCH_WEIGHTS: SearchWeights = {
  semantic: 0,
  metadata: 0,
  image: 1,
};
const STRUCTURED_SEARCH_WEIGHTS: SearchWeights = {
  semantic: 0,
  metadata: 0,
  image: 0,
};

export class RetrievalService {
  private readonly lexicons = new Map<Channel, Promise<CatalogLexicon>>();

  constructor(
    private readonly repository: CatalogRepository,
    private readonly provider: EmbeddingProvider,
    private readonly selectQueryProvider?: QueryProviderSelector,
  ) {}

  async search(
    query: string,
    channel: Channel = DEFAULT_CHANNEL,
    limit = 12,
  ): Promise<SearchResult> {
    const normalized = query.trim();
    if (!normalized) {
      throw new Error("A search query is required.");
    }
    const lexicon = await this.catalogLexicon(channel);
    const intent = analyzeCatalogQuery(normalized, lexicon);
    if (intent.titleAssetIds.length === 1) {
      const exactTitleResult = await this.searchFromExactTitle(
        normalized,
        intent.titleAssetIds[0],
        channel,
        limit,
      );
      if (exactTitleResult) return exactTitleResult;
    }
    const embeddingQuery = intent.residualQuery;
    const queryProvider = embeddingQuery
      ? (this.selectQueryProvider?.(embeddingQuery) ?? this.provider)
      : this.provider;
    let imageVector = new Array<number>(queryProvider.imageDimensions).fill(0);
    if (embeddingQuery) {
      try {
        imageVector = (await queryProvider.embedImageText([embeddingQuery]))[0];
      } catch (error) {
        throw new Error(
          `The image channel failed to embed the query: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const vectors: AssetVectors = {
      semantic: imageVector,
      metadata: imageVector,
      image: imageVector,
    };
    const searchImageVector = embeddingQuery ? imageVector : undefined;
    const activeWeights = imageVector
      ? embeddingQuery
        ? IMAGE_SEARCH_WEIGHTS
        : STRUCTURED_SEARCH_WEIGHTS
      : STRUCTURED_SEARCH_WEIGHTS;
    const ranking: SearchRanking = embeddingQuery
      ? "image"
      : "structured";
    const baseLimit = limit * 2;
    const facetFilters = {
      ...(intent.creatorNames.length
        ? { creatorNames: intent.creatorNames }
        : {}),
      ...(intent.cultures.length ? { cultures: intent.cultures } : {}),
      ...(intent.artistNationalities.length
        ? { artistNationalities: intent.artistNationalities }
        : {}),
      ...(intent.mediumTerms.length
        ? { mediumTerms: intent.mediumTerms }
        : {}),
      ...(intent.yearRange ? { yearRange: intent.yearRange } : {}),
    };
    const baseResults = await this.repository.search({
      vectors,
      weights: activeWeights,
      limit: baseLimit,
      channel,
      imageVector: searchImageVector,
      imageSpace: queryProvider.imageSpace,
      ...facetFilters,
    });
    const results = baseResults.slice(0, limit);

    return {
      query: normalized,
      channel,
      ranking,
      embeddingModel: queryProvider.name,
      weights: activeWeights,
      results,
    };
  }

  private catalogLexicon(channel: Channel): Promise<CatalogLexicon> {
    const existing = this.lexicons.get(channel);
    if (existing) return existing;
    const pending = this.repository
      .catalogAssets(channel)
      .then(buildCatalogLexicon);
    this.lexicons.set(channel, pending);
    return pending;
  }

  private async searchFromExactTitle(
    query: string,
    assetId: string,
    channel: Channel,
    limit: number,
  ): Promise<SearchResult | null> {
    const [asset, vectors] = await Promise.all([
      this.repository.findAsset(assetId),
      this.repository.findAssetVectors(assetId, this.provider.imageSpace),
    ]);
    if (!asset || !vectors) return null;

    const imageVector = vectors.image;
    if (!imageVector) {
      throw new Error(
        `The exact-title match ${asset.id} has no image embedding for the active model.`,
      );
    }

    const weights = IMAGE_SEARCH_WEIGHTS;
    const ranking: SearchRanking = "image";
    const neighborLimit = Math.max(0, limit - 1);
    const neighbors =
      neighborLimit === 0
        ? []
        : await this.repository.search({
            vectors,
            weights,
            limit: neighborLimit,
            channel,
            excludeAssetId: asset.id,
            mode: "whole",
            imageVector,
            imageSpace: this.provider.imageSpace,
          });
    const pinned: ScoredAsset = {
      asset,
      score: 1,
      scores: {
        semantic: 1,
        metadata: 1,
        ...(imageVector ? { image: 1 } : {}),
      },
    };
    const results = [pinned, ...neighbors].slice(0, limit);

    return {
      query,
      channel,
      ranking,
      embeddingModel: this.provider.name,
      weights,
      results,
    };
  }

  /** Similar items are always drawn from the source asset's own channel. */
  async similar(assetId: string, limit = 12): Promise<SearchResult> {
    const [asset, vectors] = await Promise.all([
      this.repository.findAsset(assetId),
      this.repository.findAssetVectors(assetId, this.provider.imageSpace),
    ]);
    if (!asset || !vectors) {
      throw new Error(`Asset not found: ${assetId}`);
    }
    const channel = channelOf(asset) ?? DEFAULT_CHANNEL;
    if (!vectors.image) {
      throw new Error(`Asset ${assetId} has no image embedding.`);
    }
    const weights = IMAGE_SEARCH_WEIGHTS;
    const results = await this.repository.search({
      vectors,
      weights,
      limit,
      channel,
      excludeAssetId: assetId,
      // The source's whole character is the signal, not any single label.
      mode: "whole",
      imageVector: vectors.image,
      imageSpace: this.provider.imageSpace,
    });
    return {
      query: `Similar to ${asset.title}`,
      channel,
      ranking: "image",
      embeddingModel: this.provider.name,
      weights,
      results,
    };
  }
}
