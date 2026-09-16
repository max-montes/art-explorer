import { describe, expect, it } from "vitest";
import {
  isArtworkObject,
  isPaintingObject,
  mapMetObject,
  MetObjectNotFoundError,
  isMetObject,
  DEFAULT_MET_QUERIES,
  normalizeMetQueries,
  normalizeMetObjectIDs,
  mergeMetObjectIDs,
  type MetObject,
} from "@/lib/catalog/met";

const baseObject: MetObject = {
  objectID: 1,
  isPublicDomain: true,
  objectURL: "https://www.metmuseum.org/art/collection/search/1",
  primaryImage: "https://images.example/1.jpg",
  title: "Study of a Figure",
  objectName: "Drawing",
  department: "Drawings and Prints",
  classification: "Drawings",
  artistDisplayName: "Example Artist",
  artistDisplayBio: "1900–1980",
  objectDate: "1920",
  culture: "French",
  medium: "Graphite on paper",
};

describe("Met importer", () => {
  it("accepts public-domain objects with an artwork department and image", () => {
    expect(isArtworkObject(baseObject)).toBe(true);
    expect(
      isArtworkObject({
        ...baseObject,
        department: "Musical Instruments",
        classification: "Musical instruments",
      }),
    ).toBe(false);
    expect(isArtworkObject({ ...baseObject, primaryImage: "" })).toBe(false);
    expect(isArtworkObject({ ...baseObject, isPublicDomain: false })).toBe(false);
  });

  it("accepts painting classifications but rejects vase-like art objects", () => {
    expect(
      isPaintingObject({ ...baseObject, classification: "Paintings" }),
    ).toBe(true);
    expect(
      isPaintingObject({
        ...baseObject,
        classification: "Vases",
        department: "European Decorative Arts",
      }),
    ).toBe(false);
    expect(
      isPaintingObject({
        ...baseObject,
        classification: "Decorative Arts",
      }),
    ).toBe(false);
  });

  it("maps metadata and searchable associations into a MediaAsset", () => {
    const asset = mapMetObject(baseObject);
    expect(asset).toMatchObject({
      id: "met-1",
      type: "artwork",
      libraryCategory: "artwork",
      title: "Study of a Figure",
      creator: "Example Artist",
      year: "1920",
      source: {
        provider: "The Metropolitan Museum of Art",
        mediaUrl: "https://images.example/1.jpg",
        license: "CC0 / Public Domain",
      },
    });
    expect(asset.semantics.associations).toEqual([
      "Drawings and Prints",
      "Drawings",
      "French",
      "Graphite on paper",
    ]);
    expect(asset.semantics.subjects).toEqual(asset.semantics.associations);
  });

  it("uses stable fallbacks for sparse creator and date metadata", () => {
    const asset = mapMetObject({
      ...baseObject,
      artistDisplayName: "",
      objectDate: "",
      title: "",
      objectName: "",
    });
    expect(asset.creator).toBe("Unknown Creator");
    expect(asset.year).toBe("Unknown");
    expect(asset.title).toBe("Untitled");
  });

  it("identifies missing Met objects so an importer can skip them", () => {
    const error = new MetObjectNotFoundError(936281);
    expect(error).toBeInstanceOf(MetObjectNotFoundError);
    expect(error.objectID).toBe(936281);
    expect(error.message).toContain("936281");
  });

  it("normalizes search IDs and ignores null or malformed values", () => {
    expect(normalizeMetObjectIDs([1, null, 2.5, "3", 1, 0, -4])).toEqual([1]);
    expect(normalizeMetObjectIDs(null)).toEqual([]);
    expect(isMetObject({ objectID: 9, isPublicDomain: true })).toBe(true);
    expect(isMetObject({ objectID: null, isPublicDomain: true })).toBe(false);
  });

  it("provides a balanced default and deduplicates repeatable queries", () => {
    expect(normalizeMetQueries([])).toEqual([...DEFAULT_MET_QUERIES]);
    expect(
      normalizeMetQueries([" painting ", "sculpture", "painting", ""]),
    ).toEqual(["painting", "sculpture"]);
    expect(mergeMetObjectIDs([[1, 2, null], [2, 3, "4"]])).toEqual([1, 2, 3]);
  });

  it("accepts sparse object responses when required identity fields exist", () => {
    const sparse = {
      objectID: 2,
      isPublicDomain: true,
      objectURL: "https://www.metmuseum.org/art/collection/search/2",
      primaryImage: "https://images.example/2.jpg",
      department: "European Paintings",
      classification: null,
    };
    expect(isMetObject(sparse)).toBe(true);
    expect(isArtworkObject(sparse)).toBe(true);
    expect(mapMetObject(sparse).title).toBe("Untitled");
  });
});
