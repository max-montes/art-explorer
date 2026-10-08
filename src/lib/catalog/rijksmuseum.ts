import type { MediaAsset } from "./types";

export interface RijksArtwork {
  id: string;
  objectNumber: string;
  title: string;
  creator: string;
  date: string;
  description?: string;
  subjects: string[];
  materials: string[];
  sourceUrl: string;
  imageUrl: string;
  rightsUrl: string;
}

const yearRange = (value: string) => {
  const years = [...value.matchAll(/\b(\d{4})\b/g)].map((match) =>
    Number(match[1]),
  );
  return {
    begin: years[0],
    end: years.at(-1),
  };
};

export function isRijksPainting(artwork: RijksArtwork): boolean {
  return (
    artwork.objectNumber.startsWith("SK-") &&
    Boolean(artwork.id && artwork.title && artwork.sourceUrl && artwork.imageUrl) &&
    artwork.rightsUrl.includes("publicdomain")
  );
}

export function mapRijksPainting(artwork: RijksArtwork): MediaAsset {
  const dates = yearRange(artwork.date);
  const subjects = [...new Set(artwork.subjects.filter(Boolean))];
  return {
    id: `rijks-${artwork.id}`,
    type: "artwork",
    libraryCategory: "artwork",
    title: artwork.title,
    creator: artwork.creator || "Unknown Creator",
    year: artwork.date || "Unknown",
    department: "Rijksmuseum Paintings",
    culture: "European",
    medium: artwork.materials.join("; ") || undefined,
    objectBeginDate: dates.begin,
    objectEndDate: dates.end,
    source: {
      provider: "Rijksmuseum",
      sourceUrl: artwork.sourceUrl,
      mediaUrl: artwork.imageUrl.replace("/full/max/", "/full/843,/"),
      license: "Public Domain Mark",
      licenseUrl: artwork.rightsUrl,
    },
    semantics: {
      associations: subjects,
      concepts: [],
      moods: [],
      subjects,
      description:
        artwork.description ||
        [artwork.title, artwork.creator, artwork.materials.join("; ")]
          .filter(Boolean)
          .join(" — "),
      narrative: [artwork.date, "Rijksmuseum Paintings"]
        .filter(Boolean)
        .join(" — "),
      curatorNotes: "Imported from the Rijksmuseum Linked Open Data service.",
    },
    ownerId: null,
  };
}
