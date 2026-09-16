import { createHash } from "node:crypto";

export interface ArtworkIdentification {
  provider: string;
  title: string;
  creator: string;
  year: string;
  sourceUrl: string;
  license: string;
  licenseUrl?: string;
  /**
   * Where the creator name came from. "wikidata" is a canonical label and safe
   * to use as-is; "credit" is the uploader's free-text attribution and may be
   * abbreviated, a photographer, or spelled differently from other files.
   */
  creatorSource: "wikidata" | "credit" | "none";
  /** Wikidata item for the artwork, when Commons links one. */
  wikidataId?: string;
}

export interface ArtworkIdentifier {
  readonly name: string;
  identify(bytes: Uint8Array): Promise<ArtworkIdentification | null>;
}

type Fetch = typeof fetch;

interface CommonsImage {
  name: string;
  pageid?: number;
  descriptionurl?: string;
  extmetadata?: Record<string, { value?: string }>;
}

interface WikibaseSnak {
  mainsnak?: {
    datavalue?: { value?: { id?: string; time?: string } };
  };
}

interface WikibaseEntity {
  labels?: Record<string, { value?: string }>;
  claims?: Record<string, WikibaseSnak[]>;
  statements?: Record<string, WikibaseSnak[]>;
}

const USER_AGENT = "art-explorer-curator/0.1 (local development tool)";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

// Wikidata properties.
const DIGITAL_REPRESENTATION_OF = "P6243";
const CREATOR = "P170";
const INCEPTION = "P571";

export const cleanCommonsText = (value: string | undefined) =>
  (value ?? "")
    .replace(/<[^>]+>/g, " ")
    // Commons appends Wikidata qualifiers such as "date QS:P571,+1776-..." and
    // "label QS:Len,..." to plain-text fields.
    .replace(/\s*(?:date|label)\s+QS:.*$/is, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export const titleFromCommonsName = (name: string) =>
  name
    .replace(/^File:/, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/_/g, " ")
    .trim();

/**
 * Reduce a Commons DateTimeOriginal to the display form the catalog uses.
 * Handles "1776", "circa 1510", "1509–1511", "between 1830 and 1831",
 * "1812 Romanticism (second half…)", and "17th century". Returns "" for
 * camera timestamps ("2016-07-16 23:25"), which describe the photo, not the
 * artwork.
 */
export const normalizeCommonsYear = (raw: string): string => {
  const text = raw.trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) return "";

  const century = text.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+century\b/i);
  const range = text.match(/\b(\d{4})\s*(?:[-–—]|to|and)\s*(\d{4})\b/);
  const year = text.match(/\b(\d{4})\b/);
  const approximate = /\b(?:c(?:irca)?\.?|ca\.?|about|around)\b/i.test(text);

  if (range) return `${approximate ? "c. " : ""}${range[1]}–${range[2]}`;
  if (year) return `${approximate ? "c. " : ""}${year[1]}`;
  if (century) return `${century[1]}${century[0].match(/st|nd|rd|th/i)?.[0] ?? "th"} century`;
  return "";
};

/** Wikidata time values look like "+1777-00-00T00:00:00Z". */
export const yearFromWikidataTime = (time: string | undefined) => {
  const match = time?.match(/^[+-]?(\d{1,4})-/);
  return match ? String(Number(match[1])) : "";
};

export { creatorNeedsReview } from "./creator-name";

const firstId = (entity: WikibaseEntity | undefined, property: string) => {
  const statements = entity?.statements ?? entity?.claims;
  return statements?.[property]?.[0]?.mainsnak?.datavalue?.value?.id;
};

const firstTime = (entity: WikibaseEntity | undefined, property: string) =>
  entity?.claims?.[property]?.[0]?.mainsnak?.datavalue?.value?.time;

export class WikimediaCommonsIdentifier implements ArtworkIdentifier {
  readonly name = "Wikimedia Commons";

  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly commonsEndpoint = COMMONS_API,
    private readonly wikidataEndpoint = WIKIDATA_API,
  ) {}

  async identify(bytes: Uint8Array): Promise<ArtworkIdentification | null> {
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    const payload = await this.getJson<{
      query?: { allimages?: CommonsImage[] };
    }>(this.commonsEndpoint, {
      action: "query",
      list: "allimages",
      aisha1: sha1,
      aiprop: "url|extmetadata",
      // Prefer English titles/descriptions when Commons has multilingual values.
      aiextmetadatalanguage: "en",
    });
    const image = payload.query?.allimages?.[0];
    if (!image) return null;

    const meta = image.extmetadata ?? {};
    const field = (key: string) => cleanCommonsText(meta[key]?.value);
    const credit = field("Artist");
    const base: ArtworkIdentification = {
      provider: this.name,
      title: field("ObjectName") || titleFromCommonsName(image.name),
      creator: credit,
      year: normalizeCommonsYear(field("DateTimeOriginal")),
      sourceUrl:
        image.descriptionurl ??
        `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(image.name)}`,
      license: field("LicenseShortName") || "See source",
      licenseUrl: field("LicenseUrl") || undefined,
      creatorSource: credit ? "credit" : "none",
    };

    // Structured data is best-effort: any failure leaves the credit in place.
    try {
      return await this.withStructuredData(image, base);
    } catch {
      return base;
    }
  }

  /**
   * Prefer the painting's own Wikidata item (linked from the file as
   * "digital representation of"): canonical title, creator label, inception.
   * Fall back to a creator statement on the file itself.
   */
  private async withStructuredData(
    image: CommonsImage,
    base: ArtworkIdentification,
  ): Promise<ArtworkIdentification> {
    const pageid = image.pageid ?? (await this.pageId(image.name));
    if (!pageid) return base;

    const media = (
      await this.getJson<{ entities?: Record<string, WikibaseEntity> }>(
        this.commonsEndpoint,
        { action: "wbgetentities", ids: `M${pageid}`, props: "claims" },
      )
    ).entities?.[`M${pageid}`];

    const artworkId = firstId(media, DIGITAL_REPRESENTATION_OF);
    let creatorId = firstId(media, CREATOR);
    let title = base.title;
    let year = base.year;

    if (artworkId) {
      const artwork = (
        await this.getJson<{ entities?: Record<string, WikibaseEntity> }>(
          this.wikidataEndpoint,
          {
            action: "wbgetentities",
            ids: artworkId,
            props: "labels|claims",
            languages: "en",
          },
        )
      ).entities?.[artworkId];
      title = artwork?.labels?.en?.value || title;
      year = yearFromWikidataTime(firstTime(artwork, INCEPTION)) || year;
      creatorId = firstId(artwork, CREATOR) ?? creatorId;
    }

    if (!creatorId) return { ...base, title, year, wikidataId: artworkId };

    const creator = (
      await this.getJson<{ entities?: Record<string, WikibaseEntity> }>(
        this.wikidataEndpoint,
        {
          action: "wbgetentities",
          ids: creatorId,
          props: "labels",
          languages: "en",
        },
      )
    ).entities?.[creatorId]?.labels?.en?.value;

    return creator
      ? {
          ...base,
          title,
          year,
          creator,
          creatorSource: "wikidata",
          wikidataId: artworkId,
        }
      : { ...base, title, year, wikidataId: artworkId };
  }

  private async pageId(name: string) {
    const payload = await this.getJson<{
      query?: { pages?: Record<string, { pageid?: number }> };
    }>(this.commonsEndpoint, { action: "query", titles: `File:${name}` });
    const page = Object.values(payload.query?.pages ?? {})[0];
    return page?.pageid;
  }

  private async getJson<T>(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<T> {
    const query = new URLSearchParams({ ...params, format: "json" });
    const response = await this.fetchImpl(`${endpoint}?${query}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        response.status === 429
          ? "Wikimedia is rate limiting lookups. Try again in a moment."
          : `Wikimedia lookup failed (${response.status}).`,
      );
    }
    return (await response.json()) as T;
  }
}
