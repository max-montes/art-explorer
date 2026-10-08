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
});
