import { describe, expect, it } from "vitest";
import {
  reciprocalRankFusion,
  semanticScore,
} from "@/lib/retrieval/scoring";
import { MemoryCatalogRepository } from "@/lib/retrieval/memory-repository";
import { DeterministicEmbeddingProvider } from "@/lib/retrieval/providers";
import { RetrievalService } from "@/lib/retrieval/service";
import { curatedAsset } from "./fixtures/curated-catalog";

const unit = (index: number, dims = 4) => {
  const v = new Array<number>(dims).fill(0);
  v[index] = 1;
  return v;
};

describe("label scoring", () => {
  const asset = curatedAsset("x", "X", "Unknown creator", ["Death", "Books", "Saint"]);

  it("lets the best-matching label carry the score", () => {
    const vectors = {
      semantic: unit(3),
      metadata: unit(3),
      labels: [unit(0), unit(1), unit(2)],
    };
    const score = semanticScore(unit(0), asset, vectors, "labels");
    expect(score.semantic).toBeCloseTo(1);
    expect(score.matchedLabel).toBe("Death");
  });

  describe("reciprocal rank fusion", () => {
    it("rewards support across independent rankings without combining raw scores", () => {
      const a = curatedAsset("a", "A", "Unknown", []);
      const b = curatedAsset("b", "B", "Unknown", []);
      const c = curatedAsset("c", "C", "Unknown", []);
      const result = (asset: typeof a, score: number) => ({
        asset,
        score,
        scores: { semantic: score, metadata: score },
      });

      const fused = reciprocalRankFusion(
        [
          [result(a, 0.9), result(b, 0.8), result(c, 0.1)],
          [result(b, 100), result(c, 10), result(a, 1)],
        ],
        3,
      );

      expect(fused[0].asset.id).toBe("curated-b");
      expect(fused[0].score).toBeGreaterThan(fused[1].score);
    });
  });

  it("adds a small bonus for additional strong labels, capped at 1", () => {
    const q = [1, 0, 0, 0];
    const near = [0.8, 0.6, 0, 0]; // cos = 0.8
    const vectors = {
      semantic: unit(3),
      metadata: unit(3),
      labels: [q, near, unit(2)],
    };
    const score = semanticScore(q, asset, vectors, "labels");
    // Best is 1.0 exactly; the bonus cannot push past 1.
    expect(score.semantic).toBe(1);
    expect(score.matchedLabel).toBe("Death");
  });

  it("prefers a work with two relevant labels over one with a single equal match", () => {
    // "heartbreak": Love ≈ 0.54 on all three, but only Rejected Poet also has
    // Rejection ≈ 0.40. The bonus must be large enough to break that tie and
    // small enough never to beat a clearly stronger single match.
    const q = [1, 0, 0, 0];
    const love = [0.54, Math.sqrt(1 - 0.54 ** 2), 0, 0]; // cos 0.54
    const rejection = [0.4, 0, Math.sqrt(1 - 0.4 ** 2), 0]; // cos 0.40 (> 0.7*0.54)
    const garden = [0.2, 0, 0, Math.sqrt(1 - 0.2 ** 2)]; // cos 0.20 (below floor)
    const one = { semantic: unit(3), metadata: unit(3), labels: [love, garden] };
    const two = { semantic: unit(3), metadata: unit(3), labels: [love, rejection] };
    const strong = { semantic: unit(3), metadata: unit(3), labels: [[0.7, Math.sqrt(1 - 0.49), 0, 0]] };
    const s1 = semanticScore(q, asset, one, "labels").semantic;
    const s2 = semanticScore(q, asset, two, "labels").semantic;
    const s3 = semanticScore(q, asset, strong, "labels").semantic;
    expect(s2).toBeGreaterThan(s1);
    expect(s2 - s1).toBeGreaterThan(0.005);
    expect(s3).toBeGreaterThan(s2);
  });

  it("falls back to the whole-list vector when labels are absent or mode is whole", () => {
    const vectors = { semantic: [0.6, 0.8, 0, 0], metadata: unit(3) };
    expect(semanticScore(unit(1), asset, vectors, "labels").semantic).toBeCloseTo(0.8);
    const withLabels = { ...vectors, labels: [unit(0), unit(1), unit(2)] };
    const whole = semanticScore(unit(1), asset, withLabels, "whole");
    expect(whole.semantic).toBeCloseTo(0.8);
    expect(whole.matchedLabel).toBeUndefined();
  });
});

describe("literal label matches are not diluted by long lists", () => {
  it("ranks a work tagged 'Death' among eight others above a one-word unrelated work", async () => {
    const provider = new DeterministicEmbeddingProvider();
    const jerome = curatedAsset("jerome", "Saint Jerome", "Caravaggio", [
      "Death",
      "Old age",
      "Saint",
      "Skull",
      "Books",
      "Intellectual",
      "Somber",
      "Writing",
      "Candlelight",
    ]);
    const thinker = curatedAsset("thinker", "The Thinker", "Rodin", ["Thinking"]);
    const desespere = curatedAsset("desespere", "Le Désespéré", "Courbet", [
      "Desperation",
      "Insanity",
      "Anxiety",
      "Gaze",
      "Madness",
      "Eyes",
    ]);
    const repository = new MemoryCatalogRepository(
      [thinker, desespere, jerome],
      [],
      [],
      provider,
    );
    const service = new RetrievalService(repository, provider);

    const response = await service.search("death", "artwork");
    expect(response.results[0].asset.id).toBe("curated-jerome");
    expect(response.results[0].matchedLabel).toBe("Death");
    // The literal match scores far above anything else.
    expect(response.results[0].scores.semantic).toBeGreaterThan(0.9);
    expect(response.results[1].scores.semantic).toBeLessThan(0.5);
  });
});
