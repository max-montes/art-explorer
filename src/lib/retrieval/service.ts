import {
  assetAssociations,
  channelOf,
  DEFAULT_CHANNEL,
  type AssetVectors,
  type Channel,
  type ConceptPill,
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
import { stemLabel } from "./stem";

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

/**
 * A result contributes follow-up pills only if it matched meaningfully: above
 * an absolute floor and not far behind the best match.
 */
const PILL_SOURCE_FLOOR = 0;
const PILL_SOURCE_RELATIVE = 0.5;

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
    const pinWeights = IMAGE_SEARCH_WEIGHTS;
    const titlePins = intent.titleAssetIds.length
      ? await this.repository.search({
          vectors,
          weights: pinWeights,
          limit: Math.min(limit, intent.titleAssetIds.length),
          channel,
          imageVector: searchImageVector,
          imageSpace: queryProvider.imageSpace,
          assetIds: intent.titleAssetIds,
        })
      : [];
    const results = [
      ...new Map(
        [...titlePins, ...baseResults].map((result) => [
          result.asset.id,
          result,
        ]),
      ).values(),
    ].slice(0, limit);
    const pills = await this.pillsFor(normalized, results);

    return {
      query: normalized,
      channel,
      ranking,
      embeddingModel: queryProvider.name,
      weights: activeWeights,
      results,
      pills,
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
      pills: await this.pillsFor(query, results),
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
    // Suggest from the source asset's own associations, then its neighbours.
    const pills = await this.pillsFor(asset.title, [
      { asset, score: 1, scores: weights },
      ...results,
    ]);
    return {
      query: `Similar to ${asset.title}`,
      channel,
      ranking: "image",
      embeddingModel: this.provider.name,
      weights,
      results,
      pills,
    };
  }

  /**
   * Follow-up searches drawn from the top matches' associations, interleaved
   * round-robin so every strong match contributes rather than the first
   * result's list crowding out the rest. The query itself, and inflectional
   * variants of it, are never offered.
   */
  private async pillsFor(
    query: string,
    results: ScoredAsset[],
  ): Promise<ConceptPill[]> {
    const queryStem = stemLabel(query);
    const pills = new Map<string, ConceptPill>();
    // Only results that genuinely matched should shape follow-ups. With few
    // curated works, the top 3 by position may include near-zero scores.
    const best = results[0]?.score ?? 0;
    const lists = results
      .slice(0, 3)
      .filter(
        (result) =>
          result.score >= PILL_SOURCE_FLOOR &&
          result.score >= best * PILL_SOURCE_RELATIVE,
      )
      .map((result) => {
      const labels = assetAssociations(result.asset);
      // Lead with the label that matched, then the rest in curator order.
      if (result.matchedLabel) {
        const i = labels.indexOf(result.matchedLabel);
        if (i > 0) labels.unshift(...labels.splice(i, 1));
      }
      return labels;
    });
    const longest = Math.max(0, ...lists.map((list) => list.length));
    for (let i = 0; i < longest && pills.size < 6; i++) {
      for (const list of lists) {
        const label = list[i];
        if (!label) continue;
        const stem = stemLabel(label);
        if (!stem || stem === queryStem || pills.has(stem)) continue;
        pills.set(stem, { id: label, label });
        if (pills.size >= 6) break;
      }
    }
    return [...pills.values()];
  }
}
