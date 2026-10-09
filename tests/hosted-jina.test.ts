import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedJinaEmbeddingProvider } from "@/lib/retrieval/providers";

describe("hosted Jina provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("embeds retrieval queries at 256 dimensions in input order", async () => {
    const first = Array.from({ length: 256 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const second = Array.from({ length: 256 }, (_, index) =>
      index === 1 ? 1 : 0,
    );
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: second },
            { index: 0, embedding: first },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", request);

    const provider = new HostedJinaEmbeddingProvider("test-key");
    const vectors = await provider.embedImageText(["joy", "tension"]);

    expect(vectors).toEqual([first, second]);
    expect(request).toHaveBeenCalledWith(
      "https://api.jina.ai/v1/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: "jina-clip-v2",
      input: [{ text: "joy" }, { text: "tension" }],
      task: "retrieval.query",
      dimensions: 256,
      normalized: true,
    });
  });

  it("sends image URLs and base64 data without a query task", async () => {
    const vector = Array.from({ length: 256 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: vector },
            { index: 1, embedding: vector },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", request);

    const provider = new HostedJinaEmbeddingProvider("test-key");
    await provider.embedImages([
      "https://example.com/art.jpg",
      "data:image/png;base64,aGVsbG8=",
    ]);

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body.input).toEqual([
      { image: "https://example.com/art.jpg" },
      { image: "aGVsbG8=" },
    ]);
    expect(body).not.toHaveProperty("task");
  });

  it("embeds title documents with the retrieval passage task", async () => {
    const vector = Array.from({ length: 256 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ index: 0, embedding: vector }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", request);

    const provider = new HostedJinaEmbeddingProvider("test-key");
    await provider.embedImageDocuments(["Misty Sea"]);

    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(body).toMatchObject({
      input: [{ text: "Misty Sea" }],
      task: "retrieval.passage",
    });
  });

  it("retries rate limits without changing input order", async () => {
    const vector = Array.from({ length: 256 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: vector }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", request);

    const provider = new HostedJinaEmbeddingProvider("test-key");
    await expect(provider.embedImageText(["joy"])).resolves.toEqual([vector]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces permanent API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("invalid input", { status: 400 })),
    );

    const provider = new HostedJinaEmbeddingProvider("test-key");
    await expect(provider.embedImageText(["joy"])).rejects.toThrow(
      "Jina API failed (400): invalid input",
    );
  });
});
