import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSearchResult } from "@/lib/retrieval/client-request";

const result = { query: "ships", ranking: "image", results: [] };
const success = () => Response.json(result);

describe("cold-start search requests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns warm results without retrying", async () => {
    const fetch = vi.fn().mockResolvedValue(success());
    vi.stubGlobal("fetch", fetch);
    expect(
      await fetchSearchResult("/api/search?q=ships", new AbortController().signal),
    ).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries transient gateway errors during wake-up", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("starting", { status: 503 }))
      .mockResolvedValueOnce(new Response("starting", { status: 504 }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal("fetch", fetch);
    const pending = fetchSearchResult("/api/search?q=ships", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops after bounded retries and surfaces unavailability", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () =>
      new Response("unavailable", { status: 502 }));
    vi.stubGlobal("fetch", fetch);
    const assertion = expect(
      fetchSearchResult("/api/search?q=ships", new AbortController().signal),
    ).rejects.toThrow("temporarily unavailable");
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry application errors", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ error: "Invalid query." }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchSearchResult("/api/search?q=ships", new AbortController().signal),
    ).rejects.toThrow("Invalid query.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels retry waits when navigation supersedes a search", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(new Response("starting", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const assertion = expect(
      fetchSearchResult("/api/search?q=ships", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("provides an explicit timeout error", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      })));
    const assertion = expect(
      fetchSearchResult("/api/search?q=ships", new AbortController().signal),
    ).rejects.toThrow("took too long");
    timeout.abort();
    await assertion;
  });
});
