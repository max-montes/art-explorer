import { describe, expect, it } from "vitest";
import { isArtworkObject, mapMetObject, type MetObject } from "@/lib/catalog/met";

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
});
