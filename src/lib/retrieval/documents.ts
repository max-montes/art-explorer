import {
  assetAssociations,
  type AssetVectors,
  type EmbeddingDocuments,
  type MediaAsset,
} from "@/lib/catalog/types";
import type { EmbeddingProvider, ImageEmbeddingProvider } from "./providers";

const canonicalList = (values: string[]) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .join("; ");

/**
 * One semantic document per asset, built only from curator associations
 * (deduplicated and sorted so the same labels always yield the same text), and
 * a metadata document so title/creator searches still resolve.
 */
export function buildEmbeddingDocuments(
  asset: MediaAsset,
): EmbeddingDocuments {
  return {
    semantic: `Subjects: ${canonicalList(assetAssociations(asset))}`,
    metadata: [
      `Title: ${asset.title}`,
      `Creator: ${asset.creator}`,
      `Media type: ${asset.type}`,
      `Year: ${asset.year}`,
      `Description: ${asset.semantics.description}`,
      `Context: ${asset.semantics.narrative}`,
    ].join("\n"),
  };
}

export function buildQueryDocuments(query: string): EmbeddingDocuments {
  const normalized = query.trim();
  return {
    semantic: normalized,
    metadata: `Title, creator, or named subject: ${normalized}`,
  };
}

/**
 * Embed everything search needs for one asset in a single provider call: the
 * whole-list semantic document, the metadata document, and one vector per
 * association (in `assetAssociations` order, so label scores can be traced
 * back to a label). The only place asset vectors are produced.
 */
export async function embedAsset(
  asset: MediaAsset,
  provider: EmbeddingProvider,
): Promise<{ documents: EmbeddingDocuments; vectors: AssetVectors }> {
  return (await embedAssets([asset], provider))[0];
}

export async function embedAssets(
  assets: MediaAsset[],
  provider: EmbeddingProvider,
): Promise<Array<{ documents: EmbeddingDocuments; vectors: AssetVectors }>> {
  if (!assets.length) return [];
  const documents = assets.map(buildEmbeddingDocuments);
  const embeddedDocuments = await provider.embed([
    ...assets.flatMap((asset, index) => [
      documents[index].semantic,
      documents[index].metadata,
      ...assetAssociations(asset),
    ]),
  ]);
  let documentIndex = 0;
  const results: Array<{
    documents: EmbeddingDocuments;
    vectors: AssetVectors;
  }> = assets.map((asset, index) => {
    const assetDocuments = documents[index];
    const semantic = embeddedDocuments[documentIndex++];
    const metadata = embeddedDocuments[documentIndex++];
    const labels = assetAssociations(asset).map(
      () => embeddedDocuments[documentIndex++],
    );
    return {
      documents: assetDocuments,
      vectors: { semantic, metadata, labels },
    };
  });

  if (
    process.env.IMAGE_EMBEDDINGS === "true" &&
    "embedImages" in provider
  ) {
    const imageProvider = provider as EmbeddingProvider & ImageEmbeddingProvider;
    const imageAssets = assets.filter(
      asset =>
        asset.source.mediaUrl &&
        /^(https?:|data:)/i.test(asset.source.mediaUrl),
    );
    if (imageAssets.length) {
      const imageVectors = await embedImagesWithFailureIsolation(
        imageAssets,
        imageProvider,
      );
      for (const [assetIndex, result] of results.entries()) {
        const image = imageVectors.get(assets[assetIndex].id);
        if (image) result.vectors.image = image;
      }
    }
  }
  return results;
}

async function embedImagesWithFailureIsolation(
  assets: MediaAsset[],
  provider: ImageEmbeddingProvider,
): Promise<Map<string, number[]>> {
  try {
    const vectors = await provider.embedImages(
      assets.map(asset => asset.source.mediaUrl as string),
    );
    if (vectors.length !== assets.length) {
      throw new Error(
        `CLIP returned ${vectors.length} vectors for ${assets.length} images.`,
      );
    }
    return new Map(assets.map((asset, index) => [asset.id, vectors[index]]));
  } catch (error) {
    if (assets.length === 1) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[Catalog] skipped image embedding for ${assets[0].id}: ${message}`,
      );
      return new Map();
    }
    const middle = Math.ceil(assets.length / 2);
    const [left, right] = await Promise.all([
      embedImagesWithFailureIsolation(assets.slice(0, middle), provider),
      embedImagesWithFailureIsolation(assets.slice(middle), provider),
    ]);
    return new Map([...left, ...right]);
  }
}
