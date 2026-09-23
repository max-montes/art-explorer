import {
  assetAssociations,
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
  TextQuery,
  VectorQuery,
} from "./repository";
import { combinedScore, cosine, semanticScore } from "./scoring";

const normalizeWords = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

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

  async catalogAssets(channel: "artwork"): Promise<MediaAsset[]> {
    return this.assets.filter((asset) => channelOf(asset) === channel);
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
          channelOf(asset) === query.channel &&
          (!query.creatorNames?.length ||
            query.creatorNames.includes(asset.creator)) &&
          (!query.assetIds?.length || query.assetIds.includes(asset.id)) &&
          ((!query.cultures?.length &&
            !query.artistNationalities?.length) ||
            Boolean(
              (asset.culture && query.cultures?.includes(asset.culture)) ||
                (asset.artistNationality &&
                  query.artistNationalities?.includes(
                    asset.artistNationality,
                  )),
            )) &&
          (!query.mediumTerms?.length ||
            query.mediumTerms.some((term) =>
              normalizeWords(asset.medium ?? "").join(" ").includes(term),
            )) &&
          (!query.yearRange ||
            ((asset.objectBeginDate ?? Number.POSITIVE_INFINITY) <=
              query.yearRange.end &&
              (asset.objectEndDate ?? Number.NEGATIVE_INFINITY) >=
                query.yearRange.start &&
              (asset.objectEndDate ?? Number.POSITIVE_INFINITY) -
                (asset.objectBeginDate ?? Number.NEGATIVE_INFINITY) <=
                100)),
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
          ...(query.imageVector && vectors.image
            ? { image: cosine(query.imageVector, vectors.image) }
            : {}),
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

  async textSearch(query: TextQuery): Promise<ScoredAsset[]> {
    const words = normalizeWords(query.text);
    if (!words.length) return [];
    return this.assets
      .filter(
        (asset) =>
          channelOf(asset) === query.channel &&
          (!query.creatorNames?.length ||
            query.creatorNames.includes(asset.creator)) &&
          (!query.assetIds?.length || query.assetIds.includes(asset.id)) &&
          ((!query.cultures?.length &&
            !query.artistNationalities?.length) ||
            Boolean(
              (asset.culture && query.cultures?.includes(asset.culture)) ||
                (asset.artistNationality &&
                  query.artistNationalities?.includes(
                    asset.artistNationality,
                  )),
            )) &&
          (!query.mediumTerms?.length ||
            query.mediumTerms.some((term) =>
              normalizeWords(asset.medium ?? "").join(" ").includes(term),
            )) &&
          (!query.yearRange ||
            ((asset.objectBeginDate ?? Number.POSITIVE_INFINITY) <=
              query.yearRange.end &&
              (asset.objectEndDate ?? Number.NEGATIVE_INFINITY) >=
                query.yearRange.start &&
              (asset.objectEndDate ?? Number.POSITIVE_INFINITY) -
                (asset.objectBeginDate ?? Number.NEGATIVE_INFINITY) <=
                100)),
      )
      .map((asset) => {
        const document = normalizeWords(
          [
            asset.title,
            asset.creator,
            asset.year,
            asset.culture,
            asset.medium,
            ...assetAssociations(asset),
          ].join(" "),
        );
        const matches = words.filter((word) => document.includes(word)).length;
        return {
          asset,
          score: matches / words.length,
          scores: { semantic: 0, metadata: matches / words.length },
        };
      })
      .filter((result) => result.score > 0)
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
