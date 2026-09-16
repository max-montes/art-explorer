import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryCatalogRepository } from "@/lib/retrieval/memory-repository";
import { DeterministicEmbeddingProvider } from "@/lib/retrieval/providers";
import { RetrievalService } from "@/lib/retrieval/service";
import { curatedFixtures } from "./fixtures/curated-catalog";

interface EvaluationCase {
  query: string;
  expectedFirst: string;
  reason: string;
}

const evaluations = JSON.parse(
  readFileSync(new URL("./evaluation.fixture.json", import.meta.url), "utf8"),
) as EvaluationCase[];

describe("canonical retrieval evaluation", () => {
  const provider = new DeterministicEmbeddingProvider();
  const service = new RetrievalService(
    new MemoryCatalogRepository(curatedFixtures, [], [], provider),
    provider,
  );

  for (const evaluation of evaluations) {
    it(`${evaluation.query} -> ${evaluation.expectedFirst}`, async () => {
      const response = await service.search(evaluation.query);
      expect(response.results[0].asset.id, evaluation.reason).toBe(
        evaluation.expectedFirst,
      );
    });
  }
});
