import { describe, expect, it } from "vitest";
import {
  isRijksPainting,
  mapRijksPainting,
  type RijksArtwork,
} from "@/lib/catalog/rijksmuseum";

const painting: RijksArtwork = {
  id: "200100988",
  objectNumber: "SK-C-1726",
  title: "Misty Sea",
  creator: "Jan Toorop",
  date: "1899",
  description: "A mysterious pointillist seascape.",
  subjects: ["beach", "crustacean fishery"],
  materials: ["canvas", "oil paint (paint)"],
  sourceUrl:
    "https://www.rijksmuseum.nl/nl/collectie/object/SK-C-1726--example",
  imageUrl: "https://iiif.micr.io/mPymb/full/max/0/default.jpg",
  rightsUrl: "http://creativecommons.org/publicdomain/mark/1.0/",
};

describe("Rijksmuseum catalog mapping", () => {
  it("accepts public-domain paintings with images", () => {
    expect(isRijksPainting(painting)).toBe(true);
    expect(
      isRijksPainting({ ...painting, rightsUrl: "https://example.com/copyright" }),
    ).toBe(false);
    expect(isRijksPainting({ ...painting, imageUrl: "" })).toBe(false);
    expect(
      isRijksPainting({ ...painting, objectNumber: "AK-MAK-180" }),
    ).toBe(false);
  });

  it("maps Linked Open Data fields and resizes IIIF sources", () => {
    expect(mapRijksPainting(painting)).toMatchObject({
      id: "rijks-200100988",
      title: "Misty Sea",
      creator: "Jan Toorop",
      year: "1899",
      culture: "European",
      medium: "canvas; oil paint (paint)",
      objectBeginDate: 1899,
      objectEndDate: 1899,
      source: {
        provider: "Rijksmuseum",
        mediaUrl: "https://iiif.micr.io/mPymb/full/843,/0/default.jpg",
        license: "Public Domain Mark",
      },
      semantics: {
        associations: ["beach", "crustacean fishery"],
        description: "A mysterious pointillist seascape.",
      },
    });
  });
});
