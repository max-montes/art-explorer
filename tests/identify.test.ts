import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cleanCommonsText,
  creatorNeedsReview,
  normalizeCommonsYear,
  titleFromCommonsName,
  WikimediaCommonsIdentifier,
  yearFromWikidataTime,
} from "@/lib/curation/identify";

const bytes = new Uint8Array([1, 2, 3, 4]);

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const commonsResponse = (allimages: unknown[]) =>
  json({ query: { allimages } });

const alcibiadesFile = {
  name: "Vincent,_Alcibiade_recevant_les_leçons_de_Socrate.jpg",
  pageid: 12345,
  descriptionurl: "https://commons.wikimedia.org/wiki/File:Vincent_Alcibiade.jpg",
  extmetadata: {
    ObjectName: { value: "Alcibiade recevant les leçons de Socrate" },
    Artist: { value: '<a href="https://en.wikipedia.org/wiki/Vincent">F.-A. Vincent</a>' },
    DateTimeOriginal: { value: "1776date QS:P571,+1776-00-00T00:00:00Z/9" },
    LicenseShortName: { value: "Public domain" },
  },
};

/** Routes mocked requests by API action and entity id. */
const wikimediaFake =
  (options: { structured?: boolean } = { structured: true }) =>
  async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const action = url.searchParams.get("action");
    const ids = url.searchParams.get("ids");
    if (action === "query" && url.searchParams.has("aisha1")) {
      return commonsResponse([alcibiadesFile]);
    }
    if (action === "wbgetentities" && ids === "M12345") {
      return json({
        entities: {
          M12345: options.structured
            ? {
                statements: {
                  P6243: [{ mainsnak: { datavalue: { value: { id: "Q115663100" } } } }],
                },
              }
            : { statements: {} },
        },
      });
    }
    if (action === "wbgetentities" && ids === "Q115663100") {
      return json({
        entities: {
          Q115663100: {
            labels: { en: { value: "Alcibiades Receiving the Lessons of Socrates" } },
            claims: {
              P170: [{ mainsnak: { datavalue: { value: { id: "Q718975" } } } }],
              P571: [{ mainsnak: { datavalue: { value: { time: "+1777-00-00T00:00:00Z" } } } }],
            },
          },
        },
      });
    }
    if (action === "wbgetentities" && ids === "Q718975") {
      return json({
        entities: { Q718975: { labels: { en: { value: "François-André Vincent" } } } },
      });
    }
    return new Response("not found", { status: 404 });
  };

describe("Wikimedia Commons identification", () => {
  it("resolves canonical title, creator, and year through Wikidata", async () => {
    const requests: string[] = [];
    const identifier = new WikimediaCommonsIdentifier(async (input) => {
      requests.push(String(input));
      return wikimediaFake()(input);
    });

    const match = await identifier.identify(bytes);

    expect(requests[0]).toContain(
      `aisha1=${createHash("sha1").update(bytes).digest("hex")}`,
    );
    expect(match).toEqual({
      provider: "Wikimedia Commons",
      // Wikidata label beats the uploader's French title and abbreviated credit.
      title: "Alcibiades Receiving the Lessons of Socrates",
      creator: "François-André Vincent",
      year: "1777",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Vincent_Alcibiade.jpg",
      license: "Public domain",
      licenseUrl: undefined,
      creatorSource: "wikidata",
      wikidataId: "Q115663100",
    });
  });

  it("falls back to the free-text credit when the file has no structured data", async () => {
    const identifier = new WikimediaCommonsIdentifier(
      wikimediaFake({ structured: false }),
    );
    const match = await identifier.identify(bytes);

    expect(match).toMatchObject({
      title: "Alcibiade recevant les leçons de Socrate",
      creator: "F.-A. Vincent",
      year: "1776",
      creatorSource: "credit",
    });
    expect(match?.wikidataId).toBeUndefined();
  });

  it("keeps the credit when Wikidata is unreachable", async () => {
    const identifier = new WikimediaCommonsIdentifier(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("aisha1")) return commonsResponse([alcibiadesFile]);
      return new Response("", { status: 503 });
    });
    expect(await identifier.identify(bytes)).toMatchObject({
      creator: "F.-A. Vincent",
      creatorSource: "credit",
    });
  });

  it("flags credits that need a human to supply the full name", () => {
    expect(creatorNeedsReview("E. Debat-Ponsan")).toBe(true);
    expect(creatorNeedsReview("F.-A. Vincent")).toBe(true);
    expect(creatorNeedsReview("Gary Todd from Xinzheng, China")).toBe(true);
    expect(creatorNeedsReview("Attributed to Caravaggio")).toBe(true);
    expect(creatorNeedsReview("Rijksmuseum")).toBe(true);
    expect(creatorNeedsReview("Édouard Debat-Ponsan")).toBe(false);
    expect(creatorNeedsReview("Jean-Auguste-Dominique Ingres")).toBe(false);
    expect(creatorNeedsReview("Caravaggio")).toBe(false);
    expect(creatorNeedsReview("")).toBe(false);
  });

  it("reads a year from Wikidata time values", () => {
    expect(yearFromWikidataTime("+1777-00-00T00:00:00Z")).toBe("1777");
    expect(yearFromWikidataTime("+0800-01-01T00:00:00Z")).toBe("800");
    expect(yearFromWikidataTime(undefined)).toBe("");
  });

  it("returns null when the file is not an exact Commons upload", async () => {
    const identifier = new WikimediaCommonsIdentifier(async () =>
      commonsResponse([]),
    );
    expect(await identifier.identify(bytes)).toBeNull();
  });

  it("surfaces rate limiting as a retryable message", async () => {
    const identifier = new WikimediaCommonsIdentifier(
      async () => new Response("", { status: 429 }),
    );
    await expect(identifier.identify(bytes)).rejects.toThrow(/rate limiting/);
  });

  it("strips markup and Wikidata qualifiers, and derives titles from file names", () => {
    expect(
      cleanCommonsText(
        "The Course of Empire: The Consummation of Empire label QS:Len,\"The Course\"",
      ),
    ).toBe("The Course of Empire: The Consummation of Empire");
    expect(cleanCommonsText("<span>Thomas&nbsp;Cole</span>")).toBe("Thomas Cole");
    expect(titleFromCommonsName("File:Cole_Thomas_Destruction_1836.jpg")).toBe(
      "Cole Thomas Destruction 1836",
    );
  });

  it("normalizes Commons dates to catalog years", () => {
    expect(normalizeCommonsYear("1776")).toBe("1776");
    expect(normalizeCommonsYear("circa 1510")).toBe("c. 1510");
    expect(normalizeCommonsYear("ca. 1818")).toBe("c. 1818");
    expect(normalizeCommonsYear("1509–1511")).toBe("1509–1511");
    expect(normalizeCommonsYear("between 1830 and 1831")).toBe("1830–1831");
    expect(
      normalizeCommonsYear("1812 Romanticism (second half of 18th century"),
    ).toBe("1812");
    expect(normalizeCommonsYear("17th century")).toBe("17th century");
    // A camera timestamp dates the photograph, not the artwork.
    expect(normalizeCommonsYear("2016-07-16 23:25")).toBe("");
    expect(normalizeCommonsYear("")).toBe("");
    expect(normalizeCommonsYear("unknown")).toBe("");
  });
});
