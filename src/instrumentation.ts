import { preloadRetrievalModel } from "@/lib/retrieval/container";

export function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NODE_ENV !== "production"
  ) {
    return;
  }

  void preloadRetrievalModel().catch((error: unknown) => {
    console.error("[Retrieval] Jina model preload failed.", error);
  });
}
