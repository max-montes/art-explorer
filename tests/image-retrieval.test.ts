import { afterEach, describe, expect, it } from "vitest";
import { embedAsset } from "@/lib/retrieval/documents";
import { DeterministicEmbeddingProvider } from "@/lib/retrieval/providers";
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
});
