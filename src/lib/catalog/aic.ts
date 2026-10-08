import type { MediaAsset } from "./types";

export const AIC_ALLOWED_DEPARTMENTS = [
  "Painting and Sculpture of Europe",
  "Arts of the Americas",
  "Modern Art",
] as const;

export interface AicArtwork {
  id: number;
  title?: string | null;
  artist_title?: string | null;
  artist_display?: string | null;
  date_display?: string | null;
  date_start?: number | null;
  date_end?: number | null;
  main_reference_number?: string | null;
  image_id?: string | null;
  is_public_domain?: boolean | null;
  artwork_type_title?: string | null;
  classification_title?: string | null;
  department_title?: string | null;
  place_of_origin?: string | null;
  medium_display?: string | null;
  thumbnail?: {
    width?: number | null;
    height?: number | null;
    alt_text?: string | null;
  } | null;
}

const text = (value: string | null | undefined) => value?.trim() ?? "";

export function isAicPainting(value: unknown): value is AicArtwork {
  if (!value || typeof value !== "object") return false;
  const artwork = value as Partial<AicArtwork>;
  return (
    typeof artwork.id === "number" &&
    Number.isInteger(artwork.id) &&
    artwork.id > 0 &&
    artwork.is_public_domain === true &&
    text(artwork.artwork_type_title) === "Painting" &&
    AIC_ALLOWED_DEPARTMENTS.includes(
      text(artwork.department_title) as (typeof AIC_ALLOWED_DEPARTMENTS)[number],
    ) &&
    Boolean(text(artwork.image_id))
  );
}

export function mapAicArtwork(
  artwork: AicArtwork,
  iiifUrl = "https://www.artic.edu/iiif/2",
): MediaAsset {
  const title = text(artwork.title) || "Untitled";
  const creator =
    text(artwork.artist_title) ||
    text(artwork.artist_display).split("\n")[0] ||
    "Unknown Creator";
  const department = text(artwork.department_title);
  const place = text(artwork.place_of_origin);
  const classification = text(artwork.classification_title);
  const medium = text(artwork.medium_display);
  const associations = [place, classification]
    .map((value) => value.trim())
    .filter(Boolean);
  const artistNationality =
    text(artwork.artist_display).match(/\(([^,()]+),\s*(?:c\.\s*)?\d/)?.[1];
  const width = artwork.thumbnail?.width ?? undefined;
  const height = artwork.thumbnail?.height ?? undefined;

  return {
    id: `aic-${artwork.id}`,
    type: "artwork",
    libraryCategory: "artwork",
    title,
    creator,
    year: text(artwork.date_display) || "Unknown",
    department,
    culture: place || undefined,
    medium: medium || undefined,
    artistNationality: artistNationality?.trim(),
    objectBeginDate: artwork.date_start ?? undefined,
    objectEndDate: artwork.date_end ?? undefined,
    source: {
      provider: "Art Institute of Chicago",
      sourceUrl: `https://www.artic.edu/artworks/${artwork.id}`,
      mediaUrl: `${iiifUrl}/${artwork.image_id}/full/843,/0/default.jpg`,
      license: "CC0 / Public Domain",
      licenseUrl: "https://www.artic.edu/open-access/open-access-images",
    },
    semantics: {
      associations,
      concepts: [],
      moods: [],
      subjects: associations,
      description:
        text(artwork.thumbnail?.alt_text) ||
        [title, creator, medium].filter(Boolean).join(" — "),
      narrative: [text(artwork.date_display), place, department]
        .filter(Boolean)
        .join(" — "),
      curatorNotes: "Imported from the Art Institute of Chicago Open Access API.",
    },
    width,
    height,
    aspectRatio: width && height ? width / height : undefined,
    ownerId: null,
  };
}
