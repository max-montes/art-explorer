import type {
  AssetVectors,
  EmbeddingDocuments,
  LibraryCategory,
  MediaType,
} from "@/lib/catalog/types";

export type CurationState = "draft" | "approved";
export type EmbeddingStatus =
  | "not-indexed"
  | "indexing"
  | "indexed"
  | "stale";

export interface CuratorDraft {
  id: string;
  fileName: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  state: CurationState;
  mediaType: MediaType;
  libraryCategory: LibraryCategory;
  title: string;
  creator: string;
  year?: string;
  /** Pixel dimensions of the original, read at upload for still images. */
  width?: number;
  height?: number;
  source?: {
    provider: string;
    sourceUrl: string;
    license: string;
    licenseUrl?: string;
  };
  associations: string[];
  narrative: string;
  notes: string;
}

export interface ValidationIssue {
  field: keyof CuratorDraft | "duplicate";
  message: string;
}

export interface EmbeddingState {
  status: EmbeddingStatus;
  provider?: string;
  version: number;
  indexedAt?: string;
  documents?: EmbeddingDocuments;
  vectors?: AssetVectors;
}

export interface CuratorIndexRecord {
  draft: CuratorDraft;
  embedding: EmbeddingState;
  publishedPath?: string;
  updatedAt: string;
}

export interface CuratorSuggestions {
  concepts: string[];
  moods: string[];
  subjects: string[];
}
