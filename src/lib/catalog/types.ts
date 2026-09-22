export type MediaType = "artwork";
export type LibraryCategory = "artwork";

/**
 * The search API keeps a channel field for a stable response shape; Art
 * Explorer currently has one channel: artwork.
 */
export type Channel = "artwork";
export const CHANNELS: ReadonlyArray<{ id: Channel; label: string }> = [
  { id: "artwork", label: "Artwork" },
];
export const DEFAULT_CHANNEL: Channel = "artwork";
export const isChannel = (value: unknown): value is Channel =>
  CHANNELS.some((channel) => channel.id === value);

export const channelOf = (asset: {
  type: MediaType;
  libraryCategory?: LibraryCategory;
}): Channel | null => {
  return asset.libraryCategory === "artwork" || asset.type === "artwork"
    ? "artwork"
    : null;
};
export type ConceptRelation =
  | "related"
  | "contrast"
  | "cause"
  | "consequence"
  | "tension";

export interface MediaSource {
  provider: string;
  sourceUrl: string;
  mediaUrl?: string;
  license: string;
  licenseUrl?: string;
}

export interface CuratedSemantics {
  associations?: string[];
  concepts: string[];
  moods: string[];
  subjects: string[];
  description: string;
  narrative: string;
  curatorNotes?: string;
}

/**
 * Century label derived from a catalog year string, in one canonical form so
 * every work from the same period shares an association:
 *   "1776" / "c. 1776" / "1509–1511" -> "18th century" / "16th century"
 *   "450 BCE" / "c. 450 BC"           -> "5th century BCE"
 *   "17th century"                    -> "17th century" (already canonical)
 * Ranges spanning two centuries yield both. Unknown or unparsable -> [].
 */
export const centuryLabels = (year: string | undefined): string[] => {
  const text = (year ?? "").trim();
  if (!text || /^unknown$/i.test(text)) return [];

  const ordinal = (n: number) => {
    const mod100 = n % 100;
    const suffix =
      mod100 >= 11 && mod100 <= 13
        ? "th"
        : n % 10 === 1
          ? "st"
          : n % 10 === 2
            ? "nd"
            : n % 10 === 3
              ? "rd"
              : "th";
    return `${n}${suffix}`;
  };
  const bce = /\b(?:BCE?|B\.C\.E?\.?)\b/i.test(text);
  const era = bce ? " BCE" : "";

  const explicit = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+century\b/i);
  if (explicit) return [`${ordinal(Number(explicit[1]))} century${era}`];

  const years = [...text.matchAll(/\b(\d{1,4})\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0);
  if (years.length === 0) return [];

  // Year 1–100 is the 1st century; 1701–1800 the 18th.
  const centuries = [...new Set(years.map((y) => Math.ceil(y / 100)))];
  return centuries.map((c) => `${ordinal(c)} century${era}`);
};

/**
 * Subject and concept labels intentionally exclude title, creator, date, and
 * other metadata so retrieval channels remain independent.
 */
export const assetAssociations = (asset: {
  semantics: CuratedSemantics;
}): string[] => {
  return asset.semantics.associations ?? [
    ...asset.semantics.concepts,
    ...asset.semantics.moods,
    ...asset.semantics.subjects,
  ];
};

/** Display form: "societal-decay" / "societal decay" -> "Societal decay". */
export const displayLabel = (label: string) => {
  const text = label.replaceAll("-", " ").trim();
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
};

export interface MediaAsset {
  id: string;
  type: MediaType;
  libraryCategory?: LibraryCategory;
  title: string;
  creator: string;
  year: string;
  culture?: string;
  medium?: string;
  artistNationality?: string;
  objectBeginDate?: number;
  objectEndDate?: number;
  source: MediaSource;
  semantics: CuratedSemantics;
  /** Pixel dimensions of the original, when known. */
  width?: number;
  height?: number;
  aspectRatio?: number;
  dominantColor?: string;
  ownerId?: string | null;
}

export interface Concept {
  id: string;
  label: string;
  description: string;
  aliases: string[];
}

export interface ConceptEdge {
  from: string;
  to: string;
  relation: ConceptRelation;
}

/**
 * Two documents per artwork. `semantic` is the embedding of the curator's
 * associations; `metadata` covers title/creator so name searches still work.
 */
export interface EmbeddingDocuments {
  semantic: string;
  metadata: string;
}

export interface AssetVectors {
  /** Whole association list as one vector; used for similar-artwork search. */
  semantic: number[];
  metadata: number[];
  /**
   * One vector per association, in the order of `assetAssociations`. Search
   * scores an asset by its best-matching label so a literal match ("Death")
   * is not diluted by eight unrelated neighbours. Absent on records embedded
   * before this existed; they fall back to `semantic` until re-embedded.
   */
  labels?: number[][];
  /** Optional CLIP/SigLIP image-space vector (shared with image-aware text queries). */
  image?: number[];
}

export interface SearchWeights {
  semantic: number;
  metadata: number;
  image?: number;
}

export type SearchRanking = "weighted" | "rrf";

export interface ScoredAsset {
  asset: MediaAsset;
  score: number;
  scores: SearchWeights;
  /** The association that carried the semantic score, when label-scored. */
  matchedLabel?: string;
}

export interface ConceptPill {
  id: string;
  label: string;
}

export interface SearchResult {
  query: string;
  channel: Channel;
  ranking: SearchRanking;
  weights: SearchWeights;
  results: ScoredAsset[];
  pills: ConceptPill[];
}

export interface ScriptPassage {
  id: string;
  start: number;
  end: number;
  text: string;
  associations: string[];
  results: ScoredAsset[];
}

export interface ScriptAnalysis {
  text: string;
  channel: Channel;
  passages: ScriptPassage[];
  /** Optional whole-text recommendation for clients that request one. */
  recommendation?: {
    results: ScoredAsset[];
    associations: string[];
    passageCount: number;
  };
}
