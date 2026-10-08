import type { MediaAsset } from "./types";

export const CMA_ALLOWED_DEPARTMENTS = [
  "European Painting and Sculpture",
  "Modern European Painting and Sculpture",
  "American Painting and Sculpture",
] as const;

export interface CmaArtwork {
  id: number;
  accession_number?: string | null;
  share_license_status?: string | null;
  title?: string | null;
  creation_date?: string | null;
  creation_date_earliest?: number | null;
  creation_date_latest?: number | null;
  culture?: string[] | null;
  technique?: string | null;
  department?: string | null;
  collection?: string | null;
  type?: string | null;
  description?: string | null;
  url?: string | null;
  images?: {
    web?: {
      url?: string | null;
      width?: string | number | null;
      height?: string | number | null;
    } | null;
  } | null;
  creators?: Array<{
    description?: string | null;
    use_in_caption?: boolean | null;
  }> | null;
}

const text = (value: string | null | undefined) => value?.trim() ?? "";

export function isCmaPainting(value: unknown): value is CmaArtwork {
  if (!value || typeof value !== "object") return false;
  const artwork = value as Partial<CmaArtwork>;
  return (
    typeof artwork.id === "number" &&
    Number.isInteger(artwork.id) &&
    artwork.id > 0 &&
    text(artwork.share_license_status) === "CC0" &&
    text(artwork.type) === "Painting" &&
    CMA_ALLOWED_DEPARTMENTS.includes(
      text(artwork.department) as (typeof CMA_ALLOWED_DEPARTMENTS)[number],
    ) &&
    Boolean(text(artwork.images?.web?.url))
  );
}

export function mapCmaArtwork(artwork: CmaArtwork): MediaAsset {
  const creatorDescription =
    artwork.creators?.find(({ use_in_caption }) => use_in_caption)
      ?.description ??
    artwork.creators?.[0]?.description ??
    "";
  const creator =
    text(creatorDescription).replace(/\s+\([^)]*\)\s*$/, "") ||
    "Unknown Creator";
  const artistNationality = text(creatorDescription).match(
    /\(([^,()]+),/,
  )?.[1];
  const cultures = (artwork.culture ?? []).map(text).filter(Boolean);
  const collection = text(artwork.collection);
  const associations = [...new Set([...cultures, collection].filter(Boolean))];
  const width = Number(artwork.images?.web?.width) || undefined;
  const height = Number(artwork.images?.web?.height) || undefined;

  return {
    id: `cma-${artwork.id}`,
    type: "artwork",
    libraryCategory: "artwork",
    title: text(artwork.title) || "Untitled",
    creator,
    year: text(artwork.creation_date) || "Unknown",
    department: text(artwork.department),
    culture: cultures.join("; ") || undefined,
    medium: text(artwork.technique) || undefined,
    artistNationality: artistNationality?.trim(),
    objectBeginDate: artwork.creation_date_earliest ?? undefined,
    objectEndDate: artwork.creation_date_latest ?? undefined,
    source: {
      provider: "Cleveland Museum of Art",
      sourceUrl:
        text(artwork.url) ||
        `https://www.clevelandart.org/art/${text(artwork.accession_number)}`,
      mediaUrl: text(artwork.images?.web?.url),
      license: "CC0",
      licenseUrl: "https://www.clevelandart.org/open-access",
    },
    semantics: {
      associations,
      concepts: [],
      moods: [],
      subjects: associations,
      description:
        text(artwork.description) ||
        [text(artwork.title), creator, text(artwork.technique)]
          .filter(Boolean)
          .join(" — "),
      narrative: [
        text(artwork.creation_date),
        cultures.join("; "),
        text(artwork.department),
      ]
        .filter(Boolean)
        .join(" — "),
      curatorNotes: "Imported from the Cleveland Museum of Art Open Access API.",
    },
    width,
    height,
    aspectRatio: width && height ? width / height : undefined,
    ownerId: null,
  };
}
