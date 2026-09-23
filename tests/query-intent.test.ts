import { describe, expect, it } from "vitest";
import {
  analyzeCatalogQuery,
  buildCatalogLexicon,
  normalizeCatalogText,
} from "@/lib/retrieval/query-intent";
import { curatedAsset } from "./fixtures/curated-catalog";

const catalog = [
  curatedAsset("rembrandt-1", "Portrait of a Man", "Rembrandt", ["Portraits"]),
  curatedAsset(
    "rembrandt-2",
    "Self-Portrait",
    "Rembrandt (Rembrandt van Rijn)",
    ["Self-portraits"],
  ),
  curatedAsset("homer-1", "The Gulf Stream", "Winslow Homer", ["Ships"]),
  curatedAsset("other-homer", "Aristotle with a Bust of Homer", "Rembrandt", [
    "Philosophers",
  ]),
  curatedAsset("church-artist", "The Heart of the Andes", "Frederic Edwin Church", [
    "Landscapes",
  ]),
  curatedAsset("church-1", "A Village Church", "Another Artist", ["Churches"]),
  curatedAsset("church-2", "Church Interior", "Another Artist", ["Churches"]),
  curatedAsset("church-3", "Church at Night", "Another Artist", ["Churches"]),
  curatedAsset("harvesters", "The Harvesters", "Pieter Bruegel", ["Harvests"]),
  curatedAsset("landscape-1", "Landscape", "Artist One", ["Landscapes"]),
  curatedAsset("landscape-2", "Landscape", "Artist Two", ["Landscapes"]),
  curatedAsset("japan", "Moon over a Temple", "Artist Three", ["Moon"], {
    culture: "Japan",
    objectBeginDate: 1650,
    objectEndDate: 1650,
  }),
  curatedAsset("dutch", "River Landscape", "Artist Four", ["River"], {
    artistNationality: "Dutch",
    medium: "Oil on canvas",
  }),
  curatedAsset("watercolor", "Study of Clouds", "Artist Five", ["Clouds"], {
    medium: "Graphite and watercolor on paper",
  }),
];
const lexicon = buildCatalogLexicon(catalog);

describe("catalog query intent", () => {
  it("normalizes accents, punctuation, and whitespace", () => {
    expect(normalizeCatalogText("  Paul Cézanne — Still Life ")).toBe(
      "paul cezanne still life",
    );
  });

  it("recognizes an unambiguous artist alias and removes filler words", () => {
    expect(analyzeCatalogQuery("paintings by Rembrandt", lexicon)).toMatchObject({
      creatorNames: ["Rembrandt", "Rembrandt (Rembrandt van Rijn)"],
      matchedCreatorAliases: ["rembrandt"],
      residualQuery: "",
    });
  });

  it("separates a creator from the visual part of a mixed query", () => {
    expect(analyzeCatalogQuery("Rembrandt dark portrait", lexicon)).toMatchObject(
      {
        residualQuery: "dark portrait",
        matchedCreatorAliases: ["rembrandt"],
      },
    );
  });

  it("allows a surname with at most two outside mentions", () => {
    expect(analyzeCatalogQuery("Homer stormy sea", lexicon)).toMatchObject({
      creatorNames: ["Winslow Homer"],
      residualQuery: "stormy sea",
    });
  });

  it("does not treat an ordinary catalog word as a surname", () => {
    expect(analyzeCatalogQuery("church at night", lexicon)).toMatchObject({
      creatorNames: [],
      residualQuery: "church at night",
    });
  });

  it("pins a distinctive exact title but not a repeated generic title", () => {
    expect(analyzeCatalogQuery("The Harvesters", lexicon)).toMatchObject({
      titleAssetIds: ["curated-harvesters"],
      creatorNames: [],
    });
    expect(analyzeCatalogQuery("Landscape", lexicon).titleAssetIds).toEqual([]);
  });

  it("extracts culture and century facets from a mixed visual query", () => {
    expect(
      analyzeCatalogQuery("Japanese moonlit landscape 17th century", lexicon),
    ).toMatchObject({
      cultures: ["Japan"],
      yearRange: { start: 1600, end: 1699 },
      residualQuery: "moonlit landscape",
    });
  });

  it("matches an origin through artist nationality", () => {
    expect(analyzeCatalogQuery("Dutch landscape", lexicon)).toMatchObject({
      cultures: [],
      artistNationalities: ["Dutch"],
      residualQuery: "landscape",
    });
  });

  it("extracts known medium terms as deterministic facets", () => {
    expect(analyzeCatalogQuery("watercolor clouds", lexicon)).toMatchObject({
      mediumTerms: ["watercolor"],
      residualQuery: "clouds",
    });
    expect(analyzeCatalogQuery("oil on canvas", lexicon)).toMatchObject({
      mediumTerms: ["oil on canvas"],
      residualQuery: "",
    });
  });
});
