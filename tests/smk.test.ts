import { describe, expect, it } from "vitest";
import {
  isSmkPainting,
  mapSmkArtwork,
  SMK_PAINTING_DEPARTMENT,
  type SmkArtwork,
} from "@/lib/catalog/smk";

const painting: SmkArtwork = {
  id: "1170004265_object",
  object_number: "KMS8914",
  public_domain: true,
  responsible_department: SMK_PAINTING_DEPARTMENT,
  object_names: [{ name: "Maleri" }],
  titles: [{ title: "Skovinteriør med kroget træ", type: "museumstitel" }],
  production: [
    {
      creator: "Ballin, Mogens",
      creator_forename: "Mogens",
      creator_surname: "Ballin",
      creator_nationality: "Dansk",
    },
  ],
  production_date: [
    {
      start: "1891-01-01T00:00:00.000Z",
      end: "1892-12-31T00:00:00.000Z",
      period: "1891-1892",
    },
  ],
  techniques: ["Tempera på pap"],
  content_subject: ["Bretagne"],
  frontend_url: "https://open.smk.dk/artwork/image/KMS8914",
  rights: "https://creativecommons.org/publicdomain/mark/1.0/",
  image_iiif_id: "https://iip.smk.dk/iiif/jp2/example.jp2",
  image_thumbnail:
    "https://iip-thumb.smk.dk/iiif/jp2/example.jp2/full/!1024,/0/default.jpg",
  alternative_images: [
    {
      iiif_id: "https://iip.smk.dk/iiif/jp2/example.jp2",
      width: 4724,
      height: 5482,
    },
  ],
};

describe("SMK catalog mapping", () => {
  it("accepts public-domain paintings with IIIF images", () => {
    expect(isSmkPainting(painting)).toBe(true);
    expect(isSmkPainting({ ...painting, public_domain: false })).toBe(false);
    expect(
      isSmkPainting({
        ...painting,
        responsible_department: "Den Kongelige Afstøbningssamling",
      }),
    ).toBe(false);
  });

  it("maps SMK metadata and IIIF media", () => {
    expect(mapSmkArtwork(painting)).toMatchObject({
      id: "smk-kms8914",
      title: "Skovinteriør med kroget træ",
      creator: "Mogens Ballin",
      year: "1891-1892",
      culture: "Dansk",
      artistNationality: "Dansk",
      objectBeginDate: 1891,
      objectEndDate: 1892,
      width: 4724,
      height: 5482,
      source: {
        provider: "Statens Museum for Kunst",
        mediaUrl:
          "https://iip-thumb.smk.dk/iiif/jp2/example.jp2/full/!1024,/0/default.jpg",
        license: "Public Domain Mark",
      },
    });
  });
});
