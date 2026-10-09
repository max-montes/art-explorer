import type { SearchResult } from "@/lib/catalog/types";

const SEARCH_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [2000, 4000];
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

async function delay(milliseconds: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function fetchSearchResult(
  url: string,
  signal: AbortSignal,
): Promise<SearchResult> {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, timeout]);
  try {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { signal: requestSignal });
      if (
        RETRYABLE_STATUSES.has(response.status) &&
        attempt < RETRY_DELAYS_MS.length
      ) {
        await response.body?.cancel();
        await delay(RETRY_DELAYS_MS[attempt], requestSignal);
        continue;
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error(
          response.ok
            ? "The explorer returned an invalid search response."
            : "The explorer is temporarily unavailable. Please try again.",
        );
      }
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : "Search failed.";
        throw new Error(message);
      }
      return payload as SearchResult;
    }
  } catch (error) {
    if (timeout.aborted && !signal.aborted) {
      throw new Error(
        "The explorer took too long to respond. Please try again in a moment.",
      );
    }
    throw error;
  }
}
