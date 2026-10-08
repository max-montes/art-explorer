import { afterEach, describe, expect, it } from "vitest";
import {
  createQueryProviderSelector,
  isArtHistoricalQuery,
} from "@/lib/retrieval/model-router";
import { TransformersEmbeddingProvider } from "@/lib/retrieval/providers";

describe("query model routing", () => {
  afterEach(() => {
    delete process.env.STYLE_EMBEDDING_MODEL;
  });

  it("detects named movements and style phrasing", () => {
    expect(isArtHistoricalQuery("French impressionism")).toBe(true);
    expect(isArtHistoricalQuery("an expressionistic portrait")).toBe(true);
    expect(isArtHistoricalQuery("in the style of Rembrandt")).toBe(true);
    expect(isArtHistoricalQuery("a picturesque harbor")).toBe(false);
    expect(isArtHistoricalQuery("loneliness at sea")).toBe(false);
  });

  it("keeps general searches on Jina and routes styles to SigLIP", () => {
    const general = new TransformersEmbeddingProvider("jinaai/jina-clip-v2");
    const select = createQueryProviderSelector(general);

    expect(select("stormy sea")).toBe(general);
    expect(select("cubism").imageSpace).toBe("siglip");
  });

  it("rejects a style model that does not match the stored vector space", () => {
    process.env.STYLE_EMBEDDING_MODEL = "Xenova/clip-vit-base-patch32";
    const general = new TransformersEmbeddingProvider("jinaai/jina-clip-v2");

    expect(() => createQueryProviderSelector(general)).toThrow(
      "STYLE_EMBEDDING_MODEL must use the stored SigLIP vector space.",
    );
  });
});
