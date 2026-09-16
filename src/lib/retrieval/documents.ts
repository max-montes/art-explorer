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
    semantic: [
      `${asset.title} by ${asset.creator}`,
      `Associations: ${canonicalList(assetAssociations(asset))}`,
    ].join("\n"),
    metadata: [
      `Title: ${asset.title}`,
      `Creator: ${asset.creator}`,
      `Media type: ${asset.type}`,
      `Year: ${asset.year}`,
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
  const documents = buildEmbeddingDocuments(asset);
  const labels = assetAssociations(asset);
  const [semantic, metadata, ...labelVectors] = await provider.embed([
    documents.semantic,
    documents.metadata,
    ...labels,
  ]);
  const image =
    process.env.IMAGE_EMBEDDINGS === "true" &&
    "embedImages" in provider &&
    asset.source.mediaUrl &&
    /^(https?:|data:)/i.test(asset.source.mediaUrl)
      ? (await (provider as EmbeddingProvider & ImageEmbeddingProvider).embedImages([
          asset.source.mediaUrl,
        ]))[0]
      : undefined;
  return {
    documents,
    vectors: { semantic, metadata, labels: labelVectors, ...(image ? { image } : {}) },
  };
}
