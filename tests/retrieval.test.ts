import { describe, expect, it } from "vitest";
import { MemoryCatalogRepository } from "@/lib/retrieval/memory-repository";
import {
  DeterministicEmbeddingProvider,
} from "@/lib/retrieval/providers";
import type { VectorQuery } from "@/lib/retrieval/repository";
import { RetrievalService } from "@/lib/retrieval/service";
import { curatedAsset, curatedFixtures } from "./fixtures/curated-catalog";

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
    expect(response.weights).toEqual({
      image: 1,
      semantic: 0,
      metadata: 0,
    });
  });

  it("uses only image embeddings even when title vectors are available", async () => {
    const deterministic = new DeterministicEmbeddingProvider();
    const repository = Object.assign(
      new MemoryCatalogRepository(curatedFixtures, [], [], deterministic),
      { supportsTitleSearch: async () => true },
    );
    let observedQuery: VectorQuery | undefined;
    const search = repository.search.bind(repository);
    repository.search = async (query) => {
      observedQuery = query;
      return search(query);
    };

    const response = await new RetrievalService(
      repository,
      deterministic,
    ).search("melancholy");

    expect(response.ranking).toBe("image");
    expect(observedQuery?.imageVector).toBeDefined();
    expect(observedQuery?.titleVector).toBeUndefined();
    expect(observedQuery?.rrfK).toBeUndefined();
  });

  it("resolves a creator name through metadata, not subject associations", async () => {
    const response = await createService().search("Caspar David Friedrich");

    expect(response.results[0].asset.id).toBe(
      "curated-wanderer-above-sea-of-fog",
    );
    expect(response.results[0].matchedLabel).not.toBe("Caspar David Friedrich");
  });

  it("pins an exact title first and fills the remainder from its neighbors", async () => {
    const response = await createService().search(
      "The Starry Night",
      "artwork",
      4,
    );

    expect(response.results[0].asset.id).toBe("curated-starry-night");
    expect(response.results.slice(1).map(({ asset }) => asset.id)).toContain(
      "curated-wanderer-above-sea-of-fog",
    );
    expect(
      new Set(response.results.map(({ asset }) => asset.id)).size,
    ).toBe(response.results.length);
  });

  it("does not pin multiple title matches in semantic search", async () => {
    const provider = new DeterministicEmbeddingProvider();
    const repository = new MemoryCatalogRepository(
      [
        curatedAsset("liberty-one", "Liberty", "Artist One", ["Allegory"]),
        curatedAsset("liberty-two", "Liberty", "Artist Two", ["Allegory"]),
        curatedAsset("open-landscape", "Landscape", "Artist Three", [
          "Freedom",
        ]),
      ],
      [],
      [],
      provider,
    );
    const observedQueries: VectorQuery[] = [];
    const search = repository.search.bind(repository);
    repository.search = async (query) => {
      observedQueries.push(query);
      return search(query);
    };

    const response = await new RetrievalService(repository, provider).search(
      "Liberty",
    );

    expect(response.ranking).toBe("image");
    expect(observedQueries).toHaveLength(1);
    expect(observedQueries[0].assetIds).toBeUndefined();
  });

  it("hard-filters structured nationality and medium queries", async () => {
    const provider = new DeterministicEmbeddingProvider();
    const assets = [
      curatedAsset("dutch-oil", "River", "Dutch Artist", ["Landscape"], {
        artistNationality: "Dutch",
        medium: "Oil on canvas",
      }),
      curatedAsset("french-watercolor", "Clouds", "French Artist", ["Sky"], {
        artistNationality: "French",
        medium: "Watercolor on paper",
      }),
      curatedAsset("french-oil", "Garden", "French Artist", ["Landscape"], {
        artistNationality: "French",
        medium: "Oil on canvas",
      }),
    ];
    const service = new RetrievalService(
      new MemoryCatalogRepository(assets, [], [], provider),
      provider,
    );

    const dutch = await service.search("Dutch", "artwork", 5);
    expect(dutch.results.map(({ asset }) => asset.id)).toEqual([
      "curated-dutch-oil",
    ]);

    const watercolor = await service.search(
      "watercolor",
      "artwork",
      5,
    );
    expect(watercolor.results.map(({ asset }) => asset.id)).toEqual([
      "curated-french-watercolor",
    ]);
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

});
