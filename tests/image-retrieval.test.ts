import { afterEach, describe, expect, it } from "vitest";
import { embedAsset } from "@/lib/retrieval/documents";
import { DeterministicEmbeddingProvider } from "@/lib/retrieval/providers";
import { MemoryCatalogRepository } from "@/lib/retrieval/memory-repository";
import { RetrievalService } from "@/lib/retrieval/service";
import { curatedFixtures } from "./fixtures/curated-catalog";

describe("image-aware embedding safety", () => {
  afterEach(() => {
    delete process.env.IMAGE_EMBEDDINGS;
  });

  it("does not send relative local-media URLs to the image model", async () => {
    process.env.IMAGE_EMBEDDINGS = "true";
    const provider = Object.assign(new DeterministicEmbeddingProvider(), {
      embedImages: async () => {
        throw new Error("relative URL should not be fetched");
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

    expect(vectors.image).toBeUndefined();
  });

  it("uses explicit CLIP, association, and metadata weights", async () => {
    process.env.IMAGE_EMBEDDINGS = "true";
    const base = new DeterministicEmbeddingProvider();
    const provider = Object.assign(base, {
      embedImageText: async () => [Array.from({ length: 512 }, () => 1)],
    });
    const service = new RetrievalService(
      new MemoryCatalogRepository(curatedFixtures, [], [], provider),
      provider,
    );

    const response = await service.search("melancholy");

    expect(response.weights).toEqual({
      image: 0.9,
      semantic: 0.05,
      metadata: 0.05,
    });
  });

  it("keeps the existing text-only weighting when CLIP is unavailable", async () => {
    process.env.IMAGE_EMBEDDINGS = "true";
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

    const response = await service.search("melancholy");

    expect(response.weights).toEqual({ semantic: 1, metadata: 0 });
  });
});
