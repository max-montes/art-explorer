import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MediaAsset, SearchResult } from "../src/lib/catalog/types";

type Judgment = "relevant" | "unsure" | "not_relevant";

interface Label {
  query: string;
  assetId: string;
  label: Judgment;
  title?: string;
}

interface EvalConfig {
  queries: Array<{
    phase: "retrospective" | "prospective";
    mode: "text" | "image";
    query: string;
  }>;
}

async function main() {
  const labelPaths = process.argv.slice(2);
  const config = JSON.parse(
    await readFile("curation/image-model-eval.json", "utf8"),
  ) as EvalConfig;
  const queries = config.queries.filter(
    ({ phase, mode }) => phase === "prospective" && mode === "text",
  );
  const judgments = new Map<string, Label>();
  for (const labelPath of labelPaths) {
    const parsed = JSON.parse(
      await readFile(path.resolve(labelPath), "utf8"),
    ) as { labels?: Label[] };
    for (const label of parsed.labels ?? []) {
      judgments.set(`${label.query}::${label.assetId}`, label);
    }
  }

  const origin = process.env.ART_EXPLORER_ORIGIN ?? "http://127.0.0.1:3000";
  const entries: Array<{
    query: string;
    candidates: MediaAsset[];
    embeddingModel?: string;
  }> = [];
  const seedLabels = [];
  for (const { query } of queries) {
    const url = new URL("/api/search", origin);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "5");
    const response = await fetch(url);
    const payload = (await response.json()) as
      | SearchResult
      | { error?: string };
    if (!response.ok || !("results" in payload)) {
      throw new Error(
        `Search failed for "${query}": ${
          "error" in payload ? payload.error : response.statusText
        }`,
      );
    }
    entries.push({
      query,
      candidates: payload.results.map(({ asset }) => asset),
      embeddingModel: payload.embeddingModel,
    });
    for (const [index, { asset }] of payload.results.entries()) {
      const existing = judgments.get(`${query}::${asset.id}`);
      if (!existing) continue;
      seedLabels.push({
        query,
        assetId: asset.id,
        rank: index + 1,
        label: existing.label,
        title: asset.title,
      });
    }
  }

  const outputPath =
    process.env.SEARCH_EVAL_OUTPUT ?? "public/current-search-eval-data.json";
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        id: process.env.SEARCH_EVAL_ID ?? "current-search",
        generatedAt: new Date().toISOString(),
        blinded: seedLabels.length === 0,
        candidateSource:
          "Current production retrieval pipeline with deterministic catalog filters",
        seedLabels,
        queries: entries,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Wrote ${outputPath}: ${entries.length * 5} candidates, ${seedLabels.length} prefilled judgments.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
