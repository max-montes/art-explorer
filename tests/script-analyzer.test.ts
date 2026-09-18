import { describe, expect, it } from "vitest";
import type { MediaAsset, ScoredAsset } from "@/lib/catalog/types";
import {
  analyzeScript,
  segmentScript,
} from "@/lib/assistant/script-analyzer";

const asset = (
  id: string,
  concepts: string[],
  moods: string[],
  subjects: string[],
): MediaAsset => ({
  id,
  type: "artwork",
  title: id,
  creator: "Fixture",
  year: "1900",
  source: {
    provider: "Fixture",
    sourceUrl: "https://example.test",
    mediaUrl: "https://example.test/image.jpg",
    license: "Fixture",
  },
  semantics: {
    concepts,
    moods,
    subjects,
    description: "Fixture description",
    narrative: "Fixture narrative",
  },
});

const scored = (media: MediaAsset): ScoredAsset => ({
  asset: media,
  score: 1,
  scores: { semantic: 1, metadata: 0.25 },
});

const noRecommendation = async () => ({ results: [] as ScoredAsset[] });

describe("script analyzer", () => {
  it("preserves exact offsets across sentences and newlines", () => {
    const text = "  Plato seeks truth.\nSociety decays; renewal follows.";
    const passages = segmentScript(text);

    expect(passages.map(({ start, end, text: passage }) => ({
      start,
      end,
      passage,
      source: text.slice(start, end),
    }))).toEqual([
      {
        start: 2,
        end: 20,
        passage: "Plato seeks truth.",
        source: "Plato seeks truth.",
      },
      {
        start: 21,
        end: 36,
        passage: "Society decays;",
        source: "Society decays;",
      },
      {
        start: 37,
        end: 53,
        passage: "renewal follows.",
        source: "renewal follows.",
      },
    ]);
  });

  it("attaches deduplicated associations and ranked media in the chosen channel", async () => {
    const searches: Array<{ query: string; channel: string }> = [];
    const school = scored(
      asset(
        "school",
        ["reason", "humanism"],
        ["harmony"],
        ["Plato", "philosophers"],
      ),
    );
    const analysis = await analyzeScript(
      "Plato seeks truth.",
      {
        async search(query, channel) {
          searches.push({ query, channel });
          return { results: [school, school] };
        },
        recommendForScript: noRecommendation,
      },
      "artwork",
    );

    expect(searches).toEqual([{ query: "Plato seeks truth.", channel: "artwork" }]);
    expect(analysis.channel).toBe("artwork");
    expect(analysis.passages[0]).toMatchObject({
      text: "Plato seeks truth.",
      associations: ["reason", "humanism", "harmony", "Plato", "philosophers"],
      results: [school, school],
    });
  });

  it.skip("legacy whole-script artwork recommendation behavior", async () => {
    const searches: string[] = [];
    const recommended: string[][] = [];
    const artwork = scored({
      ...asset("adagio", [], [], []),
      type: "artwork",
      libraryCategory: "artwork",
      semantics: {
        associations: ["Grief", "Stillness"],
        concepts: [],
        moods: [],
        subjects: [],
        description: "",
        narrative: "",
      },
    });
    const analysis = await analyzeScript(
      "Plato seeks truth. Society decays; renewal follows.",
      {
        async search(query) {
          searches.push(query);
          return { results: [] };
        },
        async recommendForScript(passages) {
          recommended.push(passages);
          return { results: [artwork] };
        },
      },
      "artwork",
    );

    // No per-passage searches; exactly one whole-script recommendation.
    expect(searches).toEqual([]);
    expect(recommended).toEqual([
      ["Plato seeks truth.", "Society decays;", "renewal follows."],
    ]);
    expect(analysis.channel).toBe("artwork");
    expect(analysis.passages.map((passage) => passage.results)).toEqual([
      [],
      [],
      [],
    ]);
    expect(analysis.recommendation).toEqual({
      results: [artwork],
      associations: ["Grief", "Stillness", "Fixture", "19th century"],
      passageCount: 3,
    });
  });

  it("rejects empty and oversized scripts", async () => {
    const retrieval = {
      search: async () => ({ results: [] }),
      recommendForScript: noRecommendation,
    };
    await expect(analyzeScript("   ", retrieval)).rejects.toThrow(
      "Paste a script",
    );
    await expect(analyzeScript("x".repeat(12_001), retrieval)).rejects.toThrow(
      "too long",
    );
  });

  it("keeps closing quotes and splits long sentences into hoverable clauses", () => {
    const text =
      "“Even class struggle has transformed into an inner struggle against oneself.” " +
      "Han calls this the violence of positivity—and it hides behind every profile, " +
      "every carefully curated routine, and every reminder designed to keep us producing.";
    const passages = segmentScript(text);

    expect(passages[0].text).toBe(
      "“Even class struggle has transformed into an inner struggle against oneself.”",
    );
    expect(passages.every((passage) => passage.text.length <= 160)).toBe(true);
    expect(passages.map((passage) => text.slice(passage.start, passage.end))).toEqual(
      passages.map((passage) => passage.text),
    );
  });
});
