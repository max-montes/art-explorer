import { describe, expect, it } from "vitest";
import { jinaRetrievalQueries } from "@/lib/retrieval/providers";

describe("Jina retrieval queries", () => {
  it("uses the instruction required by the local model for query embeddings", () => {
    expect(jinaRetrievalQueries(["joy", "stormy sea"])).toEqual([
      "Represent the query for retrieving evidence documents: joy",
      "Represent the query for retrieving evidence documents: stormy sea",
    ]);
  });
});
