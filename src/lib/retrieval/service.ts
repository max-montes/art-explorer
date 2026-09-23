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
import { buildQueryDocuments } from "./documents";
import type { EmbeddingProvider, ImageEmbeddingProvider } from "./providers";
import {
  analyzeCatalogQuery,
  buildCatalogLexicon,
  type CatalogLexicon,
} from "./query-intent";
import type { CatalogRepository } from "./repository";
import { reciprocalRankFusion } from "./scoring";
import { stemLabel } from "./stem";

/**
 * Text-only search favors subject semantics while retaining enough metadata
 * weight for explicit title and creator queries. Image-aware search uses an
 * explicit SigLIP/subject/metadata blend.
 */
const SEARCH_WEIGHTS: SearchWeights = { semantic: 0.8, metadata: 0.2 };
const HYBRID_SEARCH_WEIGHTS: SearchWeights = {
  semantic: 0.05,
  metadata: 0.05,
  image: 0.9,
};
const SIMILAR_WEIGHTS: SearchWeights = { semantic: 0.92, metadata: 0.08 };
/** A artwork recommendation is chosen on associations alone; titles are irrelevant. */
const SCRIPT_RECOMMENDATION_WEIGHTS: SearchWeights = {
  semantic: 1,
  metadata: 0,
};

/**
 * A result contributes follow-up pills only if it matched meaningfully: above
 * an absolute floor and not far behind the best match.
 */
const PILL_SOURCE_FLOOR = 0.3;
const PILL_SOURCE_RELATIVE = 0.5;
const RRF_MIN_CANDIDATES_PER_CHANNEL = 30;

const vectorBundle = async (
  provider: EmbeddingProvider,
  documents: ReturnType<typeof buildQueryDocuments>,
): Promise<AssetVectors> => {
  const [semantic, metadata] = await provider.embed([
    documents.semantic,
    documents.metadata,
  ]);
  return { semantic, metadata };
};

const normalize = (vector: number[]) => {
  const magnitude = Math.sqrt(vector.reduce((sum, c) => sum + c * c, 0));
  return magnitude === 0 ? vector : vector.map((c) => c / magnitude);
};

/**
 * Mean-pool one vector per channel across many passages. This represents the
 * tone of a whole script without hitting the embedding model's input limit.
 */
const averageBundles = (bundles: AssetVectors[]): AssetVectors => {
  const mean = (pick: (bundle: AssetVectors) => number[]) => {
    const dimensions = pick(bundles[0]).length;
    const sum = new Array<number>(dimensions).fill(0);
    for (const bundle of bundles) {
      pick(bundle).forEach((value, index) => {
        sum[index] += value;
      });
    }
    return normalize(sum.map((value) => value / bundles.length));
  };
  return {
    semantic: mean((bundle) => bundle.semantic),
    metadata: mean((bundle) => bundle.metadata),
  };
};

export class RetrievalService {
  private readonly lexicons = new Map<Channel, Promise<CatalogLexicon>>();

  constructor(
    private readonly repository: CatalogRepository,
    private readonly provider: EmbeddingProvider,
  ) {}

  async search(
    query: string,
    channel: Channel = DEFAULT_CHANNEL,
    limit = 12,
    ranking: SearchRanking = "weighted",
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
        ranking,
      );
      if (exactTitleResult) return exactTitleResult;
    }
    const embeddingQuery = intent.residualQuery || normalized;
    const vectors = await vectorBundle(
      this.provider,
      buildQueryDocuments(embeddingQuery),
    );
    let imageVector: number[] | undefined;
    if (process.env.IMAGE_EMBEDDINGS === "true") {
      if (!("embedImageText" in this.provider)) {
        throw new Error(
          "IMAGE_EMBEDDINGS is enabled but the embedding provider cannot embed image queries.",
        );
      }
      try {
        imageVector = (
          await (
            this.provider as EmbeddingProvider & ImageEmbeddingProvider
          ).embedImageText([embeddingQuery])
        )[0];
      } catch (error) {
        throw new Error(
          `The image channel failed to embed the query: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (ranking === "rrf" && !imageVector) {
      throw new Error("RRF ranking requires IMAGE_EMBEDDINGS=true.");
    }
    const activeWeights = imageVector ? HYBRID_SEARCH_WEIGHTS : SEARCH_WEIGHTS;
    const effectiveRanking = ranking;
    const baseLimit = limit * 2;
    const facetFilters = {
      ...(intent.cultures.length ? { cultures: intent.cultures } : {}),
      ...(intent.artistNationalities.length
        ? { artistNationalities: intent.artistNationalities }
        : {}),
      ...(intent.mediumTerms.length
        ? { mediumTerms: intent.mediumTerms }
        : {}),
      ...(intent.yearRange ? { yearRange: intent.yearRange } : {}),
    };
    const baseResults =
      effectiveRanking === "rrf"
        ? reciprocalRankFusion(
            await Promise.all([
              this.repository.search({
                vectors,
                weights: { semantic: 1, metadata: 0 },
                limit: Math.max(
                  RRF_MIN_CANDIDATES_PER_CHANNEL,
                  baseLimit * 3,
                ),
                channel,
                imageVector,
                ...facetFilters,
              }),
              this.repository.textSearch({
                text: intent.residualQuery,
                limit: Math.max(
                  RRF_MIN_CANDIDATES_PER_CHANNEL,
                  baseLimit * 3,
                ),
                channel,
                ...facetFilters,
              }),
              this.repository.search({
                vectors,
                weights: { semantic: 0, metadata: 0, image: 1 },
                limit: Math.max(
                  RRF_MIN_CANDIDATES_PER_CHANNEL,
                  baseLimit * 3,
                ),
                channel,
                imageVector,
                ...facetFilters,
              }),
            ]),
            baseLimit,
          )
        : await this.repository.search({
            vectors,
            weights: activeWeights,
            limit: baseLimit,
            channel,
            imageVector,
            ...facetFilters,
          });
    const pinWeights: SearchWeights = imageVector
      ? { semantic: 0, metadata: 0, image: 1 }
      : { semantic: 0, metadata: 1 };
    const hasStructuredIntent = intent.creatorNames.length > 0;
    const [titlePins, structuredPins] = await Promise.all([
      intent.titleAssetIds.length
        ? this.repository.search({
            vectors,
            weights: pinWeights,
            limit: Math.min(limit, intent.titleAssetIds.length),
            channel,
            imageVector,
            assetIds: intent.titleAssetIds,
          })
        : Promise.resolve([]),
      hasStructuredIntent
        ? this.repository.search({
            vectors,
            weights: pinWeights,
            limit,
            channel,
            imageVector,
            ...(intent.creatorNames.length
              ? { creatorNames: intent.creatorNames }
              : {}),
            ...facetFilters,
          })
        : Promise.resolve([]),
    ]);
    const results = [
      ...new Map(
        [...titlePins, ...structuredPins, ...baseResults].map((result) => [
          result.asset.id,
          result,
        ]),
      ).values(),
    ].slice(0, limit);
    const pills = await this.pillsFor(normalized, results);

    return {
      query: normalized,
      channel,
      ranking: effectiveRanking,
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
    ranking: SearchRanking,
  ): Promise<SearchResult | null> {
    const [asset, vectors] = await Promise.all([
      this.repository.findAsset(assetId),
      this.repository.findAssetVectors(assetId),
    ]);
    if (!asset || !vectors) return null;

    const imageVector = vectors.image;
    if (process.env.IMAGE_EMBEDDINGS === "true" && !imageVector) {
      throw new Error(
        `The exact-title match ${asset.id} has no SigLIP image embedding.`,
      );
    }
    if (ranking === "rrf" && !imageVector) {
      throw new Error("RRF ranking requires an image embedding.");
    }

    const weights = imageVector ? HYBRID_SEARCH_WEIGHTS : SEARCH_WEIGHTS;
    const neighborLimit = Math.max(0, limit - 1);
    const candidateLimit = Math.max(
      RRF_MIN_CANDIDATES_PER_CHANNEL,
      neighborLimit * 3,
    );
    const neighbors =
      neighborLimit === 0
        ? []
        : ranking === "rrf"
          ? reciprocalRankFusion(
              await Promise.all([
                this.repository.search({
                  vectors,
                  weights: { semantic: 1, metadata: 0 },
                  limit: candidateLimit,
                  channel,
                  excludeAssetId: asset.id,
                  mode: "whole",
                  imageVector,
                }),
                this.repository.search({
                  vectors,
                  weights: { semantic: 0, metadata: 1 },
                  limit: candidateLimit,
                  channel,
                  excludeAssetId: asset.id,
                  mode: "whole",
                  imageVector,
                }),
                this.repository.search({
                  vectors,
                  weights: { semantic: 0, metadata: 0, image: 1 },
                  limit: candidateLimit,
                  channel,
                  excludeAssetId: asset.id,
                  mode: "whole",
                  imageVector,
                }),
              ]),
              neighborLimit,
            )
          : await this.repository.search({
              vectors,
              weights,
              limit: neighborLimit,
              channel,
              excludeAssetId: asset.id,
              mode: "whole",
              imageVector,
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
      weights,
      results,
      pills: await this.pillsFor(query, results),
    };
  }

  /**
   * One recommendation for a whole script: every passage is embedded, the
   * vectors are averaged, and the channel is searched once on associations
   * alone. Used for artwork recommendations, where per-passage picks make no sense.
   */
  async recommendForScript(
    passages: string[],
    channel: Channel,
    limit = 3,
  ): Promise<{ results: ScoredAsset[]; weights: SearchWeights }> {
    const texts = passages.map((text) => text.trim()).filter(Boolean);
    if (texts.length === 0) {
      throw new Error("A script is required.");
    }
    // One embed call for all passages: 2 documents per passage.
    const documents = texts.map(buildQueryDocuments);
    const flat = await this.provider.embed(
      documents.flatMap((d) => [d.semantic, d.metadata]),
    );
    const bundles = documents.map((_, index) => ({
      semantic: flat[index * 2],
      metadata: flat[index * 2 + 1],
    }));
    const weights = SCRIPT_RECOMMENDATION_WEIGHTS;
    const results = await this.repository.search({
      vectors: averageBundles(bundles),
      weights,
      limit,
      channel,
    });
    return { results, weights };
  }

  /** Similar items are always drawn from the source asset's own channel. */
  async similar(assetId: string, limit = 12): Promise<SearchResult> {
    const [asset, vectors] = await Promise.all([
      this.repository.findAsset(assetId),
      this.repository.findAssetVectors(assetId),
    ]);
    if (!asset || !vectors) {
      throw new Error(`Asset not found: ${assetId}`);
    }
    const channel = channelOf(asset) ?? DEFAULT_CHANNEL;
    const weights = SIMILAR_WEIGHTS;
    const results = await this.repository.search({
      vectors,
      weights,
      limit,
      channel,
      excludeAssetId: assetId,
      // The source's whole character is the signal, not any single label.
      mode: "whole",
    });
    // Suggest from the source asset's own associations, then its neighbours.
    const pills = await this.pillsFor(asset.title, [
      { asset, score: 1, scores: weights },
      ...results,
    ]);
    return {
      query: `Similar to ${asset.title}`,
      channel,
      ranking: "weighted",
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
    const best = results[0]?.scores.semantic ?? 0;
    const lists = results
      .slice(0, 3)
      .filter(
        (result) =>
          result.scores.semantic >= PILL_SOURCE_FLOOR &&
          result.scores.semantic >= best * PILL_SOURCE_RELATIVE,
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
