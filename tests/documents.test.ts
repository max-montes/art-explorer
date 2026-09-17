import { describe, expect, it } from "vitest";
import {
  assetAssociations,
  centuryLabels,
  type MediaAsset,
} from "@/lib/catalog/types";
import {
  buildEmbeddingDocuments,
  buildQueryDocuments,
  embedAssets,
} from "@/lib/retrieval/documents";
import { DeterministicEmbeddingProvider } from "@/lib/retrieval/providers";

const fixture: MediaAsset = {
  id: "document-fixture",
  type: "artwork",
  title: "A Study",
  creator: "A Curator",
  year: "2026",
  source: {
    provider: "Fixture",
    sourceUrl: "https://example.test",
    license: "Fixture only",
  },
  semantics: {
    associations: ["Societal decay", "Dread", "Societal decay", "Burning city"],
    concepts: [],
    moods: [],
    subjects: [],
    description: "",
    narrative: "",
  },
};

describe("buildEmbeddingDocuments", () => {
  it("builds one canonical semantic document from associations", () => {
    const documents = buildEmbeddingDocuments(fixture);

    expect(documents.semantic).toBe(
      "A Study by A Curator\nAssociations: 21st century; A Curator; Burning city; Dread; Societal decay",
    );
    expect(documents.semantic.match(/Societal decay/g)).toHaveLength(1);
  });

  it("keeps title and creator in a separate metadata document", () => {
    const documents = buildEmbeddingDocuments(fixture);

    expect(documents.metadata).toContain("Title: A Study");
    expect(documents.metadata).toContain("Creator: A Curator");
    expect(documents.metadata).not.toContain("Societal decay");
  });

  it("is order-independent: the same labels always yield the same text", () => {
    const reordered = buildEmbeddingDocuments({
      ...fixture,
      semantics: {
        ...fixture.semantics,
        associations: ["Dread", "Burning city", "Societal decay"],
      },
    });
    expect(reordered.semantic).toBe(buildEmbeddingDocuments(fixture).semantic);
  });

  it("embeds the raw query for semantics and a name-oriented frame for metadata", () => {
    const documents = buildQueryDocuments("  societal decay ");
    expect(documents.semantic).toBe("societal decay");
    expect(documents.metadata).toBe(
      "Title, creator, or named subject: societal decay",
    );
  });

  it("embeds multiple assets in one ordered batch", async () => {
    const results = await embedAssets(
      [fixture, { ...fixture, id: "document-fixture-2", title: "Another Study" }],
      new DeterministicEmbeddingProvider(),
    );

    expect(results).toHaveLength(2);
    expect(results[0].documents.semantic).toContain("A Study");
    expect(results[1].documents.semantic).toContain("Another Study");
    expect(results[0].vectors.semantic).toHaveLength(384);
    expect(results[0].vectors.labels).toHaveLength(
      assetAssociations(fixture).length,
    );
  });

  it("treats a known creator as an association, without duplicating it", () => {
    expect(buildEmbeddingDocuments(fixture).semantic).toContain("A Curator");
    expect(
      assetAssociations({ creator: "Raphael", semantics: fixture.semantics }),
    ).toEqual(["Societal decay", "Dread", "Societal decay", "Burning city", "Raphael"]);
    expect(
      assetAssociations({
        creator: "raphael",
        semantics: { ...fixture.semantics, associations: ["Raphael", "Reason"] },
      }),
    ).toEqual(["Raphael", "Reason"]);
    for (const creator of ["Unknown creator", "unknown", "Anonymous", "", undefined]) {
      expect(
        assetAssociations({ creator, semantics: fixture.semantics }),
      ).toEqual(fixture.semantics.associations);
    }
  });

  it("derives one canonical century association from the year", () => {
    expect(centuryLabels("1776")).toEqual(["18th century"]);
    expect(centuryLabels("c. 1510")).toEqual(["16th century"]);
    expect(centuryLabels("1800")).toEqual(["18th century"]);
    expect(centuryLabels("1801")).toEqual(["19th century"]);
    expect(centuryLabels("1509–1511")).toEqual(["16th century"]);
    expect(centuryLabels("1795–1803")).toEqual(["18th century", "19th century"]);
    expect(centuryLabels("17th century")).toEqual(["17th century"]);
    expect(centuryLabels("21st century")).toEqual(["21st century"]);
    expect(centuryLabels("450 BCE")).toEqual(["5th century BCE"]);
    expect(centuryLabels("c. 450 BC")).toEqual(["5th century BCE"]);
    expect(centuryLabels("5th century BCE")).toEqual(["5th century BCE"]);
    expect(centuryLabels("Unknown")).toEqual([]);
    expect(centuryLabels("")).toEqual([]);
    expect(centuryLabels(undefined)).toEqual([]);

    expect(
      assetAssociations({
        creator: "Raphael",
        year: "1509–1511",
        semantics: { ...fixture.semantics, associations: ["Reason"] },
      }),
    ).toEqual(["Reason", "Raphael", "16th century"]);
    // A curator who already typed the century is not doubled.
    expect(
      assetAssociations({
        year: "1776",
        semantics: { ...fixture.semantics, associations: ["18th Century", "Enlightenment"] },
      }),
    ).toEqual(["18th Century", "Enlightenment"]);
  });
});
