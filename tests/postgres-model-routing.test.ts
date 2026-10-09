import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresCatalogRepository } from "@/lib/retrieval/postgres-repository";

const query = {
  vectors: { semantic: [1, 0], metadata: [1, 0], image: [1, 0] },
  weights: { semantic: 0, metadata: 0, image: 1 },
  imageVector: [1, 0],
  limit: 5,
  channel: "artwork" as const,
};

describe("PostgreSQL model routing", () => {
  it("selects the vector column matching the query provider", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresCatalogRepository({
      query: execute,
    } as unknown as Pool);

    await repository.search({ ...query, imageSpace: "siglip" });
    expect(execute.mock.calls[0][0]).toContain("embedding.image_embedding");

    await repository.search({ ...query, imageSpace: "jina-local" });
    expect(execute.mock.calls[1][0]).toContain(
      "embedding.jina_image_embedding",
    );

    await repository.search({ ...query, imageSpace: "jina-hosted" });
    expect(execute.mock.calls[2][0]).toContain(
      "embedding.jina_hosted_image_embedding",
    );
  });

  it("only enables routing when every default-space row has SigLIP", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ default_count: "3121", missing_count: "0" }],
      })
      .mockResolvedValueOnce({
        rows: [{ default_count: "3121", missing_count: "1" }],
      });
    const repository = new PostgresCatalogRepository({
      query: execute,
    } as unknown as Pool);

    await expect(repository.supportsImageSpace("siglip")).resolves.toBe(true);
    await expect(repository.supportsImageSpace("siglip")).resolves.toBe(false);
  });

  it("uses reciprocal-rank fusion when a Jina title vector is provided", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresCatalogRepository({
      query: execute,
    } as unknown as Pool);

    await repository.search({
      ...query,
      imageSpace: "jina-local",
      titleVector: [1, 0],
      rrfK: 20,
    });

    expect(execute.mock.calls[0][0]).toContain("jina_title_embedding");
    expect(execute.mock.calls[0][0]).toContain("FULL OUTER JOIN");
    expect(execute.mock.calls[0][1][12]).toBe(20);
  });

  it("disables title search when an existing database lacks the column", async () => {
    const execute = vi.fn().mockRejectedValue({ code: "42703" });
    const repository = new PostgresCatalogRepository({
      query: execute,
    } as unknown as Pool);

    await expect(repository.supportsTitleSearch()).resolves.toBe(false);
  });

  it("enables title search only after the backfill is complete", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ expected_count: "17380", missing_count: "1" }],
      })
      .mockResolvedValueOnce({
        rows: [{ expected_count: "17380", missing_count: "0" }],
      });
    const first = new PostgresCatalogRepository({
      query: execute,
    } as unknown as Pool);
    const second = new PostgresCatalogRepository({
      query: execute,
    } as unknown as Pool);

    await expect(first.supportsTitleSearch()).resolves.toBe(false);
    await expect(second.supportsTitleSearch()).resolves.toBe(true);
  });
});
