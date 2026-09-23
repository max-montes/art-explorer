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
  imageInput?: string,
): Promise<{ documents: EmbeddingDocuments; vectors: AssetVectors }> {
  return (
    await embedAssets([asset], provider, imageInput ? [imageInput] : undefined)
  )[0];
}

export async function embedAssets(
  assets: MediaAsset[],
  provider: EmbeddingProvider,
  imageInputs?: string[],
): Promise<Array<{ documents: EmbeddingDocuments; vectors: AssetVectors }>> {
  if (!assets.length) return [];
  const documents = assets.map(buildEmbeddingDocuments);
  const inputs = assets.map((asset, index) => {
    const explicit = imageInputs?.[index];
    if (explicit) return explicit;
    const mediaUrl = asset.source.mediaUrl;
    if (mediaUrl && /^(https?:|data:)/i.test(mediaUrl)) return mediaUrl;
    return [asset.title, asset.creator, ...assetAssociations(asset)].join(" ");
  });
  const embeddedImages = await embedImagesWithFailureIsolation(
    assets,
    inputs,
    provider,
  );
  const results: Array<{
    documents: EmbeddingDocuments;
    vectors: AssetVectors;
  }> = assets.map((asset, index) => {
    const assetDocuments = documents[index];
    const image = embeddedImages.get(asset.id) ?? [];
    return {
      documents: assetDocuments,
      vectors: { semantic: image, metadata: image, image },
    };
  });
  return results;
}

async function embedImagesWithFailureIsolation(
  assets: MediaAsset[],
  inputs: string[],
  provider: ImageEmbeddingProvider,
): Promise<Map<string, number[]>> {
  try {
    const vectors = await provider.embedImages(inputs);
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
      embedImagesWithFailureIsolation(
        assets.slice(0, middle),
        inputs.slice(0, middle),
        provider,
      ),
      embedImagesWithFailureIsolation(
        assets.slice(middle),
        inputs.slice(middle),
        provider,
      ),
    ]);
    return new Map([...left, ...right]);
  }
}
