import {
  assetAssociations,
  channelOf,
  DEFAULT_CHANNEL,
  type AssetVectors,
  type Channel,
  type ConceptPill,
  type ScoredAsset,
  type SearchResult,
  type SearchWeights,
} from "@/lib/catalog/types";
import { buildQueryDocuments } from "./documents";
import type { EmbeddingProvider } from "./providers";
import type { CatalogRepository } from "./repository";
import { stemLabel } from "./stem";

/**
 * Associations carry the meaning, and since the creator is itself an
 * association, every creator name in the catalog resolves on the semantic
 * channel alone. The metadata document's fixed "Title:/Creator:/Year:" frame
 * scores a steady 0.3–0.45 against almost any query, so at any positive
 * weight it reorders semantic near-ties by title wording. Search therefore
 * ignores it; Similar keeps a sliver, where shared title/creator text is a
 * weak but legitimate signal of kinship.
 */
const SEARCH_WEIGHTS: SearchWeights = { semantic: 1, metadata: 0 };
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
  constructor(
    private readonly repository: CatalogRepository,
    private readonly provider: EmbeddingProvider,
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
    const weights = SEARCH_WEIGHTS;
    const vectors = await vectorBundle(
      this.provider,
      buildQueryDocuments(normalized),
    );
    const results = await this.repository.search({
      vectors,
      weights,
      limit,
      channel,
    });
    const pills = await this.pillsFor(normalized, results);

    return { query: normalized, channel, weights, results, pills };
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
