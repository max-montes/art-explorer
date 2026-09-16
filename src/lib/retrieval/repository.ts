import type {
  AssetVectors,
  Channel,
  Concept,
  ConceptEdge,
  EmbeddingDocuments,
  MediaAsset,
  ScoredAsset,
  SearchWeights,
} from "@/lib/catalog/types";

export interface VectorQuery {
  vectors: AssetVectors;
  weights: SearchWeights;
  limit: number;
  channel: Channel;
  excludeAssetId?: string;
  /**
   * "labels" (default): score each asset by its best-matching association, so
   * a query that names one label outranks a long list that merely resembles
   * it. "whole": compare against the whole-list vector; right for Similar,
   * where the overall character of the source asset is the signal.
   */
  mode?: "labels" | "whole";
  imageVector?: number[];
}

export interface CatalogIndexEntry {
  asset: MediaAsset;
  vectors: AssetVectors;
  documents: EmbeddingDocuments;
  provider: string;
  documentVersion: number;
}

export interface CatalogRepository {
  prepare(): Promise<void>;
  findAsset(id: string): Promise<MediaAsset | null>;
  findAssetVectors(id: string): Promise<AssetVectors | null>;
  search(query: VectorQuery): Promise<ScoredAsset[]>;
  concepts(): Promise<Concept[]>;
  conceptEdges(): Promise<ConceptEdge[]>;
  upsertIndexedAsset(entry: CatalogIndexEntry): Promise<void>;
  removeIndexedAsset(id: string): Promise<void>;
}
