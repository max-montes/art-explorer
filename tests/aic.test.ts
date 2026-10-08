import { describe, expect, it } from "vitest";
import {
  isAicPainting,
  mapAicArtwork,
  type AicArtwork,
} from "@/lib/catalog/aic";

const bedroom: AicArtwork = {
  id: 28560,
  title: "The Bedroom",
  artist_title: "Vincent van Gogh",
  artist_display: "Vincent van Gogh (Dutch, 1853–1890)",
  date_display: "1889",
  date_start: 1889,
  date_end: 1889,
  image_id: "image-1",
  is_public_domain: true,
  artwork_type_title: "Painting",
  classification_title: "oil on canvas",
  department_title: "Painting and Sculpture of Europe",
  place_of_origin: "Saint-Rémy-de-Provence",
  medium_display: "Oil on canvas",
  thumbnail: {
    width: 1200,
    height: 900,
    alt_text: "A blue bedroom with a wooden bed.",
  },
};

describe("Art Institute catalog mapping", () => {
  it("accepts public-domain paintings from approved departments", () => {
    expect(isAicPainting(bedroom)).toBe(true);
    expect(
      isAicPainting({ ...bedroom, department_title: "Arts of Asia" }),
    ).toBe(false);
    expect(isAicPainting({ ...bedroom, is_public_domain: false })).toBe(false);
  });

  it("maps AIC metadata and IIIF media consistently", () => {
    expect(mapAicArtwork(bedroom)).toMatchObject({
      id: "aic-28560",
      title: "The Bedroom",
      creator: "Vincent van Gogh",
      year: "1889",
      department: "Painting and Sculpture of Europe",
      culture: "Saint-Rémy-de-Provence",
      medium: "Oil on canvas",
      artistNationality: "Dutch",
      objectBeginDate: 1889,
      objectEndDate: 1889,
      width: 1200,
      height: 900,
      aspectRatio: 4 / 3,
      source: {
        provider: "Art Institute of Chicago",
        sourceUrl: "https://www.artic.edu/artworks/28560",
        mediaUrl:
          "https://www.artic.edu/iiif/2/image-1/full/843,/0/default.jpg",
        license: "CC0 / Public Domain",
      },
      semantics: {
        description: "A blue bedroom with a wooden bed.",
      },
    });
  });
});
