import type { MediaAsset } from "./types";

export class MetObjectNotFoundError extends Error {
  constructor(public readonly objectID: number) {
    super(`Met object ${objectID} was not found.`);
    this.name = "MetObjectNotFoundError";
  }
}

export interface MetObject {
  objectID: number;
  isPublicDomain: boolean;
  objectURL: string | null;
  primaryImage: string | null;
  primaryImageSmall?: string | null;
  title: string | null;
  objectName: string | null;
  department: string | null;
  classification: string | null;
  artistDisplayName: string | null;
  artistDisplayBio: string | null;
  objectDate: string | null;
  culture: string | null;
  medium: string | null;
}

const ART_DEPARTMENTS = [
  "african",
  "american",
  "ancient near eastern",
  "asian",
  "brazilian",
  "british",
  "drawings and prints",
  "european",
  "islamic",
  "modern",
  "photographs",
  "american decorative",
];

const NON_ART_CLASSIFICATIONS = [
  "arms",
  "armor",
  "coin",
  "currency",
  "musical instrument",
  "book",
  "manuscript",
  "textile",
  "tool",
  "vessel",
];

const splitLabels = (value: string) =>
  value
    .split(/[;,]/)
    .map((label) => label.trim())
    .filter(Boolean);

const text = (value: string | null | undefined) => value?.trim() ?? "";

export function isArtworkObject(object: MetObject): boolean {
  if (!object.isPublicDomain || !text(object.primaryImage) || !text(object.objectURL)) {
    return false;
  }

  const department = text(object.department).toLowerCase();
  const classification = text(object.classification).toLowerCase();
  const hasArtDepartment = ART_DEPARTMENTS.some((name) =>
    department.includes(name),
  );
  const isExcludedClassification = NON_ART_CLASSIFICATIONS.some((name) =>
    classification.includes(name),
  );
  return hasArtDepartment && !isExcludedClassification;
}

export function mapMetObject(object: MetObject): MediaAsset {
  const title = text(object.title) || text(object.objectName) || "Untitled";
  const creator = text(object.artistDisplayName) || "Unknown Creator";
  const associations = [
    ...splitLabels(text(object.department)),
    ...splitLabels(text(object.classification)),
    ...splitLabels(text(object.culture)),
    ...splitLabels(text(object.medium)),
  ];
  const uniqueAssociations = [
    ...new Map(
      associations.map((label) => [label.toLocaleLowerCase(), label]),
    ).values(),
  ];

  return {
    id: `met-${object.objectID}`,
    type: "artwork",
    libraryCategory: "artwork",
    title,
    creator,
    year: text(object.objectDate) || "Unknown",
    source: {
      provider: "The Metropolitan Museum of Art",
      sourceUrl: text(object.objectURL),
      mediaUrl: text(object.primaryImage),
      license: "CC0 / Public Domain",
      licenseUrl:
        "https://www.metmuseum.org/policies/terms-and-conditions#art",
    },
    semantics: {
      associations: uniqueAssociations,
      concepts: [],
      moods: [],
      subjects: uniqueAssociations,
      description: [title, creator, text(object.medium)]
        .filter(Boolean)
        .join(" — "),
      narrative: [text(object.objectDate), text(object.culture)]
        .filter(Boolean)
        .join(" — "),
      curatorNotes: "Imported from The Met Open Access collection.",
    },
    ownerId: null,
  };
}
