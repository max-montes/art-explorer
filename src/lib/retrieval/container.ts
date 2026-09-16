import { Pool } from "pg";
import {
  assetAssociations,
  type AssetVectors,
  type EmbeddingDocuments,
} from "@/lib/catalog/types";
import { LocalCuratorIndexRepository } from "@/lib/curation/local-repository";
import { curatorDraftToMediaAsset } from "@/lib/curation/service";
import type { CuratorIndexRecord } from "@/lib/curation/types";
import { buildEmbeddingDocuments, embedAsset } from "./documents";
import { MemoryCatalogRepository } from "./memory-repository";
import { PostgresCatalogRepository } from "./postgres-repository";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "./providers";
import type { CatalogRepository } from "./repository";
import { RetrievalService } from "./service";

export interface CatalogRuntime {
  provider: EmbeddingProvider;
  repository: CatalogRepository;
  service: RetrievalService;
}

const globalServices = globalThis as typeof globalThis & {
  artworkRuntime?: Promise<CatalogRuntime>;
};

async function createRuntime(): Promise<CatalogRuntime> {
  const provider = createEmbeddingProvider();
  const repository =
    (process.env.CATALOG_REPOSITORY ?? "memory") === "postgres"
      ? new PostgresCatalogRepository(
          new Pool({
            connectionString:
              process.env.DATABASE_URL ??
              "postgres://art_explorer:art_explorer@localhost:5432/art_explorer",
          }),
        )
      : // The catalog has no bundled seed: every asset enters through the curator.
        new MemoryCatalogRepository([], [], [], provider);
  await repository.prepare();
  const curatorIndex = new LocalCuratorIndexRepository();
  await hydrateCuratedCatalog(repository, await curatorIndex.list(), {
    provider,
    persist: (record) => curatorIndex.upsert(record),
  });
  return {
    provider,
    repository,
    service: new RetrievalService(repository, provider),
  };
}

/**
 * Records approved before the single-association model stored identical
 * concept/mood vectors; the concept vector is the semantic vector.
 */
const currentVectors = (
  vectors: AssetVectors | { concept: number[]; metadata: number[] },
): AssetVectors =>
  "semantic" in vectors
    ? vectors
    : { semantic: vectors.concept, metadata: vectors.metadata };

const currentDocuments = (
  documents: EmbeddingDocuments | { concept: string; metadata: string },
): EmbeddingDocuments =>
  "semantic" in documents
    ? documents
    : { semantic: documents.concept, metadata: documents.metadata };

export interface HydrationOptions {
  /**
   * When given, records whose stored semantic document no longer matches what
   * the current builder produces (e.g. the creator became an association) are
   * re-embedded once and persisted, so approved items never need re-approval
   * after a retrieval change.
   */
  provider?: EmbeddingProvider;
  persist?: (record: CuratorIndexRecord) => Promise<void>;
}

export async function hydrateCuratedCatalog(
  repository: CatalogRepository,
  localRecords: CuratorIndexRecord[],
  options: HydrationOptions = {},
) {
  for (const record of localRecords) {
    if (
      !(
        record.draft.state === "approved" &&
        record.embedding.status === "indexed" &&
        record.embedding.documents &&
        record.embedding.vectors &&
        record.embedding.provider
      )
    ) {
      await repository.removeIndexedAsset(record.draft.id);
      continue;
    }

    const asset = curatorDraftToMediaAsset(record.draft);
    let documents = currentDocuments(record.embedding.documents);
    let vectors = currentVectors(record.embedding.vectors);
    let { provider: providerName, version } = record.embedding;

    const expected = buildEmbeddingDocuments(asset);
    const labelCount = assetAssociations(asset).length;
    const drifted =
      expected.semantic !== documents.semantic ||
      expected.metadata !== documents.metadata ||
      // Per-label vectors were added after the first records were approved.
      (labelCount > 0 && (vectors.labels?.length ?? 0) !== labelCount);
    if (drifted && options.provider) {
      ({ documents, vectors } = await embedAsset(asset, options.provider));
      providerName = options.provider.name;
      version += 1;
      await options.persist?.({
        ...record,
        embedding: {
          ...record.embedding,
          provider: providerName,
          version,
          indexedAt: new Date().toISOString(),
          documents,
          vectors,
        },
        updatedAt: new Date().toISOString(),
      });
    }

    await repository.upsertIndexedAsset({
      asset,
      documents,
      vectors,
      provider: providerName!,
      documentVersion: version,
    });
  }
}

export function getCatalogRuntime() {
  if (!globalServices.artworkRuntime) {
    globalServices.artworkRuntime = createRuntime();
  }
  return globalServices.artworkRuntime;
}

export async function getRetrievalService() {
  return (await getCatalogRuntime()).service;
}
