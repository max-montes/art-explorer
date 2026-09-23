import { describe, expect, it } from "vitest";
import { embedAsset } from "@/lib/retrieval/documents";
import { DeterministicEmbeddingProvider } from "@/lib/retrieval/providers";
import { MemoryCatalogRepository } from "@/lib/retrieval/memory-repository";
import { RetrievalService } from "@/lib/retrieval/service";
import { curatedFixtures } from "./fixtures/curated-catalog";

describe("image-aware embedding safety", () => {
  it("uses a textual surrogate when a local image URL is not directly readable", async () => {
    let inputs: string[] = [];
    const provider = Object.assign(new DeterministicEmbeddingProvider(), {
      embedImages: async (values: string[]) => {
        inputs = values;
        return [Array.from({ length: 384 }, () => 0)];
      },
    });

    const { vectors } = await embedAsset(
      {
        ...curatedFixtures[0],
        source: {
          ...curatedFixtures[0].source,
          mediaUrl: "/api/local-media/example",
        },
      },
      provider,
    );

    expect(inputs[0]).not.toContain("/api/local-media/");
    expect(vectors.image).toHaveLength(384);
  });

  it("ranks directly by the image model", async () => {
    const base = new DeterministicEmbeddingProvider();
    const provider = Object.assign(base, {
      embedImageText: async () => [[1, 0]],
      embedImages: async (images: string[]) =>
        images.map((image) => image.endsWith("/0") ? [1, 0] : [0, 1]),
    });
    const assets = curatedFixtures.map((asset, index) => ({
      ...asset,
      source: {
        ...asset.source,
        mediaUrl: `https://example.com/${index}`,
      },
    }));
    const service = new RetrievalService(
      new MemoryCatalogRepository(assets, [], [], provider),
      provider,
    );

    const response = await service.search("melancholy");

    expect(response.weights).toEqual({
      image: 1,
      semantic: 0,
      metadata: 0,
    });
    expect(response.ranking).toBe("image");
    expect(response.results[0].asset.id).toBe(assets[0].id);
  });

  it("fails loudly when the configured image model is unavailable", async () => {
    const base = new DeterministicEmbeddingProvider();
    const provider = Object.assign(base, {
      embedImageText: async () => {
        throw new Error("model unavailable");
      },
    });
    const service = new RetrievalService(
      new MemoryCatalogRepository(curatedFixtures, [], [], provider),
      provider,
    );

    await expect(service.search("melancholy")).rejects.toThrow(
      "The image channel failed to embed the query: model unavailable",
    );
  });
});
