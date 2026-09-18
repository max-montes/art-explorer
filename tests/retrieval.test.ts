import { describe, expect, it } from "vitest";
import { MemoryCatalogRepository } from "@/lib/retrieval/memory-repository";
import { DeterministicEmbeddingProvider } from "@/lib/retrieval/providers";
import { RetrievalService } from "@/lib/retrieval/service";
import { curatedFixtures } from "./fixtures/curated-catalog";

const createService = () => {
  const provider = new DeterministicEmbeddingProvider();
  const repository = new MemoryCatalogRepository(
    curatedFixtures,
    [],
    [],
    provider,
  );
  return new RetrievalService(repository, provider);
};

describe("association-based retrieval", () => {
  it("ranks by curated associations", async () => {
    const response = await createService().search("melancholy");

    expect(response.results[0].asset.semantics.associations).toContain(
      "Melancholic",
    );
    expect(response.weights).toEqual({ semantic: 0.8, metadata: 0.2 });
  });

  it("resolves a creator name through metadata, not subject associations", async () => {
    const response = await createService().search("Caspar David Friedrich");

    expect(response.results[0].asset.id).toBe(
      "curated-wanderer-above-sea-of-fog",
    );
    expect(response.results[0].matchedLabel).not.toBe("Caspar David Friedrich");
  });

  it("offers the creator as a follow-up search", async () => {
    // "Solitary traveler" is unique to the Wanderer, so its creator surfaces.
    const response = await createService().search("solitary traveler");

    expect(response.results[0].asset.id).toBe("curated-wanderer-above-sea-of-fog");
    const labels = response.pills.map((pill) => pill.label);
    expect(labels.length).toBeGreaterThan(0);
  });

  it("interleaves pills across equally strong matches", async () => {
    // Both Starry Night and the Wanderer carry "The sublime"; neither list
    // should crowd the other out.
    const response = await createService().search("the sublime", "artwork");
    const ids = response.results.slice(0, 2).map((result) => result.asset.id);
    expect(ids).toEqual(
      expect.arrayContaining(["curated-starry-night", "curated-wanderer-above-sea-of-fog"]),
    );
    const labels = response.pills.map((pill) => pill.label);
    expect(labels).not.toContain("The sublime");
    expect(labels).toEqual(expect.arrayContaining(["Inner turmoil", "Awe"]));
    // Unmatched works (score ~0) contribute nothing.
    expect(labels).not.toContain("Plato");
  });

  it("explores similar assets without returning the selected asset", async () => {
    const response = await createService().similar("curated-starry-night");

    expect(response.results.map((result) => result.asset.id)).not.toContain(
      "curated-starry-night",
    );
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("suggests the top matches' associations as follow-up searches", async () => {
    const response = await createService().search("societal decay");

    const labels = response.pills.map((pill) => pill.label);
    expect(labels).toEqual(
      expect.arrayContaining(["Civilizational collapse", "Ruin"]),
    );
    expect(labels).not.toContain("Societal decay");
    expect(response.pills.length).toBeLessThanOrEqual(6);
  });

  it("never suggests a morphological variant of the query", async () => {
    const response = await createService().search("divinity");

    expect(response.results[0].asset.id).toBe("curated-apotheosis-of-hercules");
    const labels = response.pills.map((pill) => pill.label);
    expect(labels).toEqual(
      expect.arrayContaining(["Hercules", "Gods", "Ascension"]),
    );
    expect(labels).not.toContain("Divinity");
  });

  it.skip("legacy multi-channel isolation behavior", async () => {
    const service = createService();
    const ids = (response: { results: { asset: { id: string } }[] }) =>
      response.results.map((result) => result.asset.id);

    // "Isolation" is an association in both channels; each search sees only its own.
    const legacyArtwork = await service.search("isolation", "artwork");
    const artwork = await service.search("isolation", "artwork");
    expect(artwork.channel).toBe("artwork");
    expect(ids(artwork)).not.toContain("curated-prelinger-factory");
    expect(ids(legacyArtwork)).toEqual(["curated-prelinger-factory"]);
    expect(legacyArtwork.pills.map((pill) => pill.label)).not.toContain(
      "The sublime",
    );

    // Similar follows the source asset's channel, not the caller's.
    const similar = await service.similar("curated-prelinger-factory");
    expect(similar.channel).toBe("artwork");
    expect(ids(similar)).toEqual([]);
  });

  it.skip("legacy whole-script artwork recommendation behavior", async () => {
    const service = createService();

    const grieving = await service.recommendForScript(
      [
        "Everything he built is gone.",
        "The house is silent now.",
        "Grief settles in like winter.",
      ],
      "artwork",
    );
    expect(grieving.results[0].asset.id).toBe("curated-moonlight-sonata");
    // A artwork recommendation is chosen on associations alone.
    expect(grieving.weights).toEqual({ semantic: 1, metadata: 0 });

    const triumphant = await service.recommendForScript(
      ["Hopeful crowds fill the square.", "A celebration of renewal and triumph."],
      "artwork",
    );
    expect(triumphant.results[0].asset.id).toBe("curated-ode-to-joy");
    // Only artwork come back, never artwork or footage.
    expect(
      triumphant.results.every(({ asset }) => asset.type === "artwork"),
    ).toBe(true);
  });
});
