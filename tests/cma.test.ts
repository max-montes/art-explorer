import { describe, expect, it } from "vitest";
import {
  isCmaPainting,
  mapCmaArtwork,
  type CmaArtwork,
} from "@/lib/catalog/cma";

const portrait: CmaArtwork = {
  id: 94979,
  accession_number: "1915.534",
  share_license_status: "CC0",
  title: "Nathaniel Hurd",
  creation_date: "c. 1765",
  creation_date_earliest: 1760,
  creation_date_latest: 1770,
  culture: ["America"],
  technique: "oil on canvas",
  department: "American Painting and Sculpture",
  collection: "American - Painting",
  type: "Painting",
  description: "A warmly observed informal portrait.",
  url: "https://clevelandart.org/art/1915.534",
  images: {
    web: {
      url: "https://example.com/1915.534_web.jpg",
      width: "748",
      height: "893",
    },
  },
  creators: [
    {
      description:
        "John Singleton Copley (American, born The Thirteen Colonies, 1738–1815)",
      use_in_caption: true,
    },
  ],
};

describe("Cleveland catalog mapping", () => {
  it("accepts CC0 paintings from approved departments", () => {
    expect(isCmaPainting(portrait)).toBe(true);
    expect(
      isCmaPainting({ ...portrait, department: "Chinese Art" }),
    ).toBe(false);
    expect(
      isCmaPainting({ ...portrait, share_license_status: "Copyrighted" }),
    ).toBe(false);
  });

  it("maps Cleveland metadata and web images", () => {
    expect(mapCmaArtwork(portrait)).toMatchObject({
      id: "cma-94979",
      title: "Nathaniel Hurd",
      creator: "John Singleton Copley",
      year: "c. 1765",
      culture: "America",
      artistNationality: "American",
      objectBeginDate: 1760,
      objectEndDate: 1770,
      width: 748,
      height: 893,
      source: {
        provider: "Cleveland Museum of Art",
        sourceUrl: "https://clevelandart.org/art/1915.534",
        mediaUrl: "https://example.com/1915.534_web.jpg",
        license: "CC0",
      },
      semantics: {
        description: "A warmly observed informal portrait.",
      },
    });
  });
});
