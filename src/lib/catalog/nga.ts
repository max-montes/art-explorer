import type { MediaAsset } from "./types";

export const NGA_PAINTING_DEPARTMENTS: Record<string, string> = {
  CAB: "American and British Paintings",
  CF: "French Paintings",
  "CIS-B": "Italian and Spanish Paintings",
  "CIS-R": "Italian and Spanish Paintings",
  "CNE-B": "Northern European Paintings",
  "CNE-R": "Northern European Paintings",
  CMC: "Modern Art",
};

export interface NgaObject {
  objectid: string;
  accessionnum: string;
  title: string;
  displaydate: string;
  beginyear: string;
  endyear: string;
  medium: string;
  attribution: string;
  classification: string;
  isvirtual: string;
  departmentabbr: string;
}

export interface NgaImage {
  uuid: string;
  iiifurl: string;
  viewtype: string;
  sequence: string;
  width: string;
  height: string;
  openaccess: string;
  depictstmsobjectid: string;
  assistivetext: string;
}

const text = (value: string | null | undefined) => value?.trim() ?? "";
const integer = (value: string) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
};

export function isNgaPainting(object: NgaObject, image?: NgaImage): boolean {
  return (
    text(object.classification) === "Painting" &&
    text(object.isvirtual) !== "1" &&
    Boolean(text(object.accessionnum)) &&
    Boolean(NGA_PAINTING_DEPARTMENTS[text(object.departmentabbr)]) &&
    image?.openaccess === "1" &&
    image.viewtype === "primary" &&
    Boolean(text(image.iiifurl))
  );
}

export function mapNgaPainting(
  object: NgaObject,
  image: NgaImage,
): MediaAsset {
  const department =
    NGA_PAINTING_DEPARTMENTS[text(object.departmentabbr)] ?? "Paintings";
  const width = integer(image.width);
  const height = integer(image.height);

  return {
    id: `nga-${object.objectid}`,
    type: "artwork",
    libraryCategory: "artwork",
    title: text(object.title) || "Untitled",
    creator: text(object.attribution) || "Unknown Creator",
    year: text(object.displaydate) || "Unknown",
    department,
    culture: department,
    medium: text(object.medium) || undefined,
    objectBeginDate: integer(object.beginyear),
    objectEndDate: integer(object.endyear),
    source: {
      provider: "National Gallery of Art",
      sourceUrl: `https://www.nga.gov/artworks/${object.objectid}`,
      mediaUrl: `${image.iiifurl}/full/!843,843/0/default.jpg`,
      license: "CC0",
      licenseUrl: "https://www.nga.gov/notices/open-access-policy.html",
    },
    semantics: {
      associations: [department],
      concepts: [],
      moods: [],
      subjects: [department],
      description:
        text(image.assistivetext) ||
        [text(object.title), text(object.attribution), text(object.medium)]
          .filter(Boolean)
          .join(" — "),
      narrative: [text(object.displaydate), department]
        .filter(Boolean)
        .join(" — "),
      curatorNotes: "Imported from the National Gallery of Art Open Data.",
    },
    width,
    height,
    aspectRatio: width && height ? width / height : undefined,
    ownerId: null,
  };
}
