import {
  channelOf,
  type AssetVectors,
  type Concept,
  type ConceptEdge,
  type MediaAsset,
  type ScoredAsset,
} from "@/lib/catalog/types";
import { embedAsset } from "./documents";
import type { EmbeddingProvider } from "./providers";
import type {
  CatalogIndexEntry,
  CatalogRepository,
  VectorQuery,
} from "./repository";
import { combinedScore, cosine, semanticScore } from "./scoring";

export class MemoryCatalogRepository implements CatalogRepository {
  private readonly vectors = new Map<string, AssetVectors>();
  private preparing?: Promise<void>;

  constructor(
    assets: MediaAsset[],
    private readonly conceptRecords: Concept[],
    private readonly edges: ConceptEdge[],
    private readonly provider: EmbeddingProvider,
  ) {
    this.assets = [...assets];
  }

  private readonly assets: MediaAsset[];

  async prepare(): Promise<void> {
    if (!this.preparing) {
      this.preparing = this.indexAssets();
    }
    await this.preparing;
  }

  async findAsset(id: string): Promise<MediaAsset | null> {
    return this.assets.find((asset) => asset.id === id) ?? null;
  }

  async findAssetVectors(id: string): Promise<AssetVectors | null> {
    await this.prepare();
    return this.vectors.get(id) ?? null;
  }

  async search(query: VectorQuery): Promise<ScoredAsset[]> {
    await this.prepare();
    return this.assets
      .filter(
        (asset) =>
          asset.id !== query.excludeAssetId &&
          channelOf(asset) === query.channel,
      )
      .map((asset) => {
        const vectors = this.vectors.get(asset.id);
        if (!vectors) {
          throw new Error(`Asset ${asset.id} has not been indexed.`);
        }
        const { semantic, matchedLabel } = semanticScore(
          query.vectors.semantic,
          asset,
          vectors,
          query.mode ?? "labels",
        );
        const scores = {
          semantic,
          metadata: cosine(query.vectors.metadata, vectors.metadata),
        };
        return {
          asset,
          score: combinedScore(scores, query.weights),
          scores,
          ...(matchedLabel ? { matchedLabel } : {}),
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit);
  }

  async concepts(): Promise<Concept[]> {
    return this.conceptRecords;
  }

  async conceptEdges(): Promise<ConceptEdge[]> {
    return this.edges;
  }

  async upsertIndexedAsset(entry: CatalogIndexEntry): Promise<void> {
    await this.prepare();
    const index = this.assets.findIndex((asset) => asset.id === entry.asset.id);
    if (index >= 0) this.assets[index] = entry.asset;
    else this.assets.push(entry.asset);
    this.vectors.set(entry.asset.id, entry.vectors);
  }

  async removeIndexedAsset(id: string): Promise<void> {
    await this.prepare();
    const index = this.assets.findIndex((asset) => asset.id === id);
    if (index >= 0) this.assets.splice(index, 1);
    this.vectors.delete(id);
  }

  private async indexAssets() {
    // Nothing bundled to embed; curated records arrive via upsertIndexedAsset.
    if (this.assets.length === 0) return;
    for (const asset of this.assets) {
      const { vectors } = await embedAsset(asset, this.provider);
      this.vectors.set(asset.id, vectors);
    }
  }
}
