import { describe, expect, it } from "vitest";
import {
  isNgaPainting,
  mapNgaPainting,
  type NgaImage,
  type NgaObject,
} from "@/lib/catalog/nga";

const object: NgaObject = {
  objectid: "12345",
  accessionnum: "1942.9.1",
  title: "A River Landscape",
  displaydate: "c. 1650",
  beginyear: "1645",
  endyear: "1655",
  medium: "oil on canvas",
  attribution: "Example Painter",
  classification: "Painting",
  isvirtual: "0",
  departmentabbr: "CNE-R",
};

const image: NgaImage = {
  uuid: "image-1",
  iiifurl: "https://api.nga.gov/iiif/image-1",
  viewtype: "primary",
  sequence: "0",
  width: "2400",
  height: "1800",
  openaccess: "1",
  depictstmsobjectid: "12345",
  assistivetext: "A broad river winds through a wooded landscape.",
};

describe("National Gallery catalog mapping", () => {
  it("accepts open-access paintings from Western painting departments", () => {
    expect(isNgaPainting(object, image)).toBe(true);
    expect(
      isNgaPainting({ ...object, departmentabbr: "CSD" }, image),
    ).toBe(false);
    expect(isNgaPainting(object, { ...image, openaccess: "0" })).toBe(false);
  });

  it("maps NGA metadata and IIIF media", () => {
    expect(mapNgaPainting(object, image)).toMatchObject({
      id: "nga-12345",
      title: "A River Landscape",
      creator: "Example Painter",
      year: "c. 1650",
      department: "Northern European Paintings",
      culture: "Northern European Paintings",
      objectBeginDate: 1645,
      objectEndDate: 1655,
      width: 2400,
      height: 1800,
      source: {
        provider: "National Gallery of Art",
        sourceUrl:
          "https://www.nga.gov/collection/art-object-page.12345.html",
        mediaUrl:
          "https://api.nga.gov/iiif/image-1/full/!843,843/0/default.jpg",
        license: "CC0",
      },
      semantics: {
        description: "A broad river winds through a wooded landscape.",
      },
    });
  });
});
