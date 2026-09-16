import { createHash } from "node:crypto";
import type { MediaAsset } from "@/lib/catalog/types";
import { embedAsset } from "@/lib/retrieval/documents";
import type { EmbeddingProvider } from "@/lib/retrieval/providers";
import type { CatalogRepository } from "@/lib/retrieval/repository";
import type { LocalMediaStore } from "./local-media-store";
import type { ArtworkIdentifier } from "./identify";
import type { CuratorIndexRepository } from "./repository";
import { LocalThumbnailStore } from "./thumbnail-store";
import type { CuratorSuggestionProvider } from "./suggestions";
import type { CuratorDraft, CuratorIndexRecord } from "./types";
import { validateForApproval } from "./validation";

export class CurationValidationError extends Error {
  constructor(
    message: string,
    readonly issues: ReturnType<typeof validateForApproval>,
  ) {
    super(message);
  }
}

export class DuplicateMediaError extends Error {
  constructor(readonly existingId: string) {
    super(`This file is already indexed as ${existingId}.`);
  }
}

const now = () => new Date().toISOString();
const categoryDirectories: Record<
  CuratorDraft["libraryCategory"],
  string[]
> = {
  artwork: ["Artwork"],
};

export const curatorDraftToMediaAsset = (draft: CuratorDraft): MediaAsset => ({
  id: draft.id,
  type: draft.mediaType,
  libraryCategory: draft.libraryCategory,
  title: draft.title || "Untitled",
  creator: draft.creator || "Unknown creator",
  year: draft.year || "Unknown",
  source: {
    ...(draft.source ?? {
      provider: "Local curator",
      sourceUrl: "/admin/curation",
      license: "Locally curated media",
    }),
    // Media is always served from the local store, whatever the provenance.
    mediaUrl: `/api/local-media/${draft.sha256}`,
  },
  semantics: {
    associations: draft.associations,
    concepts: [],
    moods: [],
    subjects: [],
    description: draft.narrative,
    narrative: draft.narrative,
    curatorNotes: draft.notes || undefined,
  },
  ...(draft.width && draft.height
    ? {
        width: draft.width,
        height: draft.height,
        aspectRatio: draft.width / draft.height,
      }
    : {}),
  ownerId: null,
});

/** Reads only the header; never decodes the full image. */
export async function readImageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ width: number; height: number } | null> {
  if (!mimeType.startsWith("image/")) return null;
  try {
    const { default: sharp } = await import("sharp");
    const { width, height, orientation } = await sharp(bytes, {
      failOn: "none",
      limitInputPixels: false,
    }).metadata();
    if (!width || !height) return null;
    // EXIF orientations 5-8 rotate the image 90°; report displayed dimensions.
    return orientation && orientation >= 5
      ? { width: height, height: width }
      : { width, height };
  } catch {
    return null;
  }
}

export class CuratorService {
  constructor(
    private readonly repository: CuratorIndexRepository,
    private readonly catalog: CatalogRepository,
    private readonly mediaStore: LocalMediaStore,
    private readonly provider: EmbeddingProvider,
    readonly suggestions: CuratorSuggestionProvider,
    private readonly identifier?: ArtworkIdentifier,
  ) {}

  /** Lists records, backfilling dimensions for images uploaded before they were recorded. */
  async list() {
    const records = await this.repository.list();
    const results: CuratorIndexRecord[] = [];
    for (const record of records) {
      const { draft } = record;
      if (draft.width || !draft.mimeType.startsWith("image/")) {
        results.push(record);
        continue;
      }
      const dimensions = await readImageDimensions(
        await this.mediaStore.read(draft.sha256),
        draft.mimeType,
      );
      if (!dimensions) {
        results.push(record);
        continue;
      }
      const updated = { ...record, draft: { ...draft, ...dimensions } };
      await this.repository.upsert(updated);
      // Keep the live catalog's copy in step so cards get the aspect ratio.
      if (
        updated.draft.state === "approved" &&
        updated.embedding.status === "indexed" &&
        updated.embedding.documents &&
        updated.embedding.vectors &&
        updated.embedding.provider
      ) {
        await this.catalog.upsertIndexedAsset({
          asset: curatorDraftToMediaAsset(updated.draft),
          documents: updated.embedding.documents,
          vectors: updated.embedding.vectors,
          provider: updated.embedding.provider,
          documentVersion: updated.embedding.version,
        });
      }
      results.push(updated);
    }
    return results;
  }

  findByHash(sha256: string) {
    return this.repository.findByHash(sha256);
  }

  /** Explicit, curator-triggered lookup; never runs on upload or approval. */
  async identify(id: string) {
    if (!this.identifier) {
      throw new Error("No artwork identifier is configured.");
    }
    const record = await this.repository.findById(id);
    if (!record) return null;
    const bytes = await this.mediaStore.read(record.draft.sha256);
    return {
      record,
      identification: await this.identifier.identify(bytes),
    };
  }

  async remove(id: string): Promise<CuratorIndexRecord | null> {
    const record = await this.repository.findById(id);
    if (!record) return null;
    await this.catalog.removeIndexedAsset(id);
    await this.mediaStore.remove(record.draft.sha256, record.publishedPath);
    await new LocalThumbnailStore().remove(record.draft.sha256);
    await this.repository.remove(id);
    return record;
  }

  async upload(
    fileName: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<{ record: CuratorIndexRecord; duplicate: boolean }> {
    const mediaType =
      mimeType.startsWith("image/") && mimeType !== "image/gif"
      ? "artwork"
      : null;
    if (!mediaType) {
      throw new Error(
        "Only still image files can enter the artwork queue.",
      );
    }
    if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) {
      throw new Error("Files must be between 1 byte and 50 MB.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = await this.repository.findByHash(sha256);
    await this.mediaStore.put(bytes);
    if (existing) return { record: existing, duplicate: true };

    const dimensions = await readImageDimensions(bytes, mimeType);
    const draft: CuratorDraft = {
      id: `curated-${sha256.slice(0, 16)}`,
      fileName,
      sha256,
      byteSize: bytes.byteLength,
      mimeType,
      state: "draft",
      mediaType,
      ...(dimensions ?? {}),
      libraryCategory: "artwork",
      title: "",
      creator: "",
      associations: [],
      narrative: "",
      notes: "",
    };
    return { record: await this.saveDraft(draft), duplicate: false };
  }

  async saveDraft(draft: CuratorDraft): Promise<CuratorIndexRecord> {
    const existing = await this.repository.findById(draft.id);
    const record: CuratorIndexRecord = {
      draft: { ...draft, state: "draft" },
      embedding: {
        status: existing?.embedding.status === "indexed" ? "stale" : "not-indexed",
        version: existing?.embedding.version ?? 0,
        provider: existing?.embedding.provider,
        indexedAt: existing?.embedding.indexedAt,
      },
      publishedPath: existing?.publishedPath,
      updatedAt: now(),
    };
    await this.catalog.removeIndexedAsset(draft.id);
    await this.repository.upsert(record);
    return record;
  }

  async approve(draft: CuratorDraft): Promise<CuratorIndexRecord> {
    const issues = validateForApproval(draft);
    if (issues.length > 0) {
      throw new CurationValidationError("Approval validation failed.", issues);
    }
    const duplicate = await this.repository.findByHash(draft.sha256);
    if (duplicate && duplicate.draft.id !== draft.id) {
      throw new DuplicateMediaError(duplicate.draft.id);
    }

    const existing = await this.repository.findById(draft.id);
    const asset = curatorDraftToMediaAsset(draft);
    const { documents, vectors } = await embedAsset(asset, this.provider);
    const publishedPath = await this.mediaStore.publish(
      draft.sha256,
      draft.fileName,
      categoryDirectories[draft.libraryCategory],
    );
    const record: CuratorIndexRecord = {
      draft: { ...draft, state: "approved" },
      embedding: {
        status: "indexed",
        provider: this.provider.name,
        version: (existing?.embedding.version ?? 0) + 1,
        indexedAt: now(),
        documents,
        vectors,
      },
      publishedPath: publishedPath ?? existing?.publishedPath,
      updatedAt: now(),
    };
    await this.repository.upsert(record);
    await this.catalog.upsertIndexedAsset({
      asset,
      documents,
      vectors: record.embedding.vectors!,
      provider: this.provider.name,
      documentVersion: record.embedding.version,
    });
    return record;
  }

}
