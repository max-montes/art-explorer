import type { MediaAsset } from "./types";

export const SMK_PAINTING_DEPARTMENT =
  "Den Kongelige Maleri- og Skulptursamling";

export interface SmkArtwork {
  id?: string | null;
  object_number?: string | null;
  public_domain?: boolean | null;
  responsible_department?: string | null;
  object_names?: Array<{ name?: string | null }> | null;
  titles?: Array<{
    title?: string | null;
    type?: string | null;
    language?: string | null;
  }> | null;
  production?: Array<{
    creator?: string | null;
    creator_forename?: string | null;
    creator_surname?: string | null;
    creator_nationality?: string | null;
  }> | null;
  production_date?: Array<{
    start?: string | null;
    end?: string | null;
    period?: string | null;
  }> | null;
  techniques?: string[] | null;
  materials?: string[] | null;
  content_subject?: string[] | null;
  frontend_url?: string | null;
  rights?: string | null;
  image_iiif_id?: string | null;
  image_thumbnail?: string | null;
  alternative_images?: Array<{
    iiif_id?: string | null;
    thumbnail?: string | null;
    width?: number | null;
    height?: number | null;
  }> | null;
}

const text = (value: string | null | undefined) => value?.trim() ?? "";

const year = (value: string | null | undefined) => {
  const match = text(value).match(/^-?(\d{1,4})/);
  return match ? Number(match[1]) : undefined;
};

export function isSmkPainting(value: unknown): value is SmkArtwork {
  if (!value || typeof value !== "object") return false;
  const artwork = value as Partial<SmkArtwork>;
  return (
    Boolean(text(artwork.object_number)) &&
    artwork.public_domain === true &&
    text(artwork.responsible_department) === SMK_PAINTING_DEPARTMENT &&
    (artwork.object_names ?? []).some(
      ({ name }) => text(name).toLocaleLowerCase() === "maleri",
    ) &&
    Boolean(text(artwork.image_thumbnail) || text(artwork.image_iiif_id))
  );
}

export function mapSmkArtwork(artwork: SmkArtwork): MediaAsset {
  const production = artwork.production?.[0];
  const creator =
    [text(production?.creator_forename), text(production?.creator_surname)]
      .filter(Boolean)
      .join(" ") ||
    text(production?.creator) ||
    "Unknown Creator";
  const preferredTitle =
    artwork.titles?.find(
      ({ type }) => text(type).toLocaleLowerCase() === "museumstitel",
    ) ?? artwork.titles?.[0];
  const date = artwork.production_date?.[0];
  const image = artwork.alternative_images?.find(({ iiif_id }) => text(iiif_id));
  const width = image?.width ?? undefined;
  const height = image?.height ?? undefined;
  const subjects = (artwork.content_subject ?? []).map(text).filter(Boolean);
  const objectNumber = text(artwork.object_number);

  return {
    id: `smk-${objectNumber.toLocaleLowerCase()}`,
    type: "artwork",
    libraryCategory: "artwork",
    title: text(preferredTitle?.title) || "Untitled",
    creator,
    year: text(date?.period) || "Unknown",
    department: SMK_PAINTING_DEPARTMENT,
    culture: text(production?.creator_nationality) || undefined,
    medium:
      [...(artwork.techniques ?? []), ...(artwork.materials ?? [])]
        .map(text)
        .filter(Boolean)
        .join("; ") || undefined,
    artistNationality: text(production?.creator_nationality) || undefined,
    objectBeginDate: year(date?.start),
    objectEndDate: year(date?.end),
    source: {
      provider: "Statens Museum for Kunst",
      sourceUrl:
        text(artwork.frontend_url) ||
        `https://open.smk.dk/artwork/image/${objectNumber}`,
      mediaUrl:
        text(artwork.image_thumbnail) ||
        `${text(artwork.image_iiif_id)}/full/843,/0/default.jpg`,
      license: "Public Domain Mark",
      licenseUrl:
        text(artwork.rights) ||
        "https://creativecommons.org/publicdomain/mark/1.0/",
    },
    semantics: {
      associations: subjects,
      concepts: [],
      moods: [],
      subjects,
      description: [
        text(preferredTitle?.title),
        creator,
        ...(artwork.techniques ?? []).map(text),
      ]
        .filter(Boolean)
        .join(" — "),
      narrative: [
        text(date?.period),
        text(production?.creator_nationality),
        SMK_PAINTING_DEPARTMENT,
      ]
        .filter(Boolean)
        .join(" — "),
      curatorNotes: "Imported from SMK's public-domain Open API.",
    },
    width,
    height,
    aspectRatio: width && height ? width / height : undefined,
    ownerId: null,
  };
}
