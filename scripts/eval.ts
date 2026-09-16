/**
 * Curator evaluation: run the queries in curation/eval.json against the real
 * curated catalog with the real embedding model, and report how often the
 * expected work comes first.
 *
 *   npm run eval              # score + misses
 *   npm run eval -- --all     # every query, including passes
 *
 * This is not a unit test. It is a measurement: rerun it after changing
 * scoring, the embedding model, or how associations are composed, and after a
 * labeling pass, to see whether search got better for the catalog you have.
 * A miss usually means a label is missing (add the word you typed to the
 * work you expected), sometimes that scoring is wrong, and occasionally that
 * the phrase is beyond the model. Write expectations before looking.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LocalCuratorIndexRepository } from "../src/lib/curation/local-repository";
import { hydrateCuratedCatalog } from "../src/lib/retrieval/container";
import { MemoryCatalogRepository } from "../src/lib/retrieval/memory-repository";
import { createEmbeddingProvider } from "../src/lib/retrieval/providers";
import { RetrievalService } from "../src/lib/retrieval/service";

interface EvalCase {
  group: string;
  query: string;
  expect: string[];
  note?: string;
  _comment?: string;
}

async function main() {
  const showAll = process.argv.includes("--all");
  const file = path.resolve(process.argv.find((a) => a.endsWith(".json")) ?? "curation/eval.json");
  const cases = (JSON.parse(await readFile(file, "utf8")) as EvalCase[]).filter(
    (c) => c.query,
  );

  const provider = createEmbeddingProvider();
  const repository = new MemoryCatalogRepository([], [], [], provider);
  await repository.prepare();
  const index = new LocalCuratorIndexRepository();
  await hydrateCuratedCatalog(repository, await index.list(), { provider });
  const service = new RetrievalService(repository, provider);

  let top1 = 0;
  let topK = 0;
  const byGroup = new Map<string, { n: number; top1: number }>();
  const lines: string[] = [];

  for (const c of cases) {
    const { results } = await service.search(c.query, "artwork");
    const titles = results.map((r) => r.asset.title);
    const k = c.expect.length;
    const firstOk = c.expect.includes(titles[0]);
    const kOk = c.expect.every((e) => titles.slice(0, k).includes(e));
    top1 += firstOk ? 1 : 0;
    topK += kOk ? 1 : 0;
    const g = byGroup.get(c.group) ?? { n: 0, top1: 0 };
    g.n++;
    g.top1 += firstOk ? 1 : 0;
    byGroup.set(c.group, g);

    if (kOk && !showAll) continue;
    const status = kOk ? "PASS" : firstOk ? "top1" : "MISS";
    const ranks = c.expect
      .map((e) => {
        const i = titles.indexOf(e);
        return `${e.slice(0, 22)}=${i === -1 ? "—" : i + 1}`;
      })
      .join(", ");
    const top = results
      .slice(0, 2)
      .map((r) => `${r.asset.title.slice(0, 20)} (${r.scores.semantic.toFixed(2)} via ${r.matchedLabel ?? "?"})`)
      .join(" · ");
    lines.push(`${status === "PASS" ? "  " : status === "top1" ? "~ " : "✗ "}[${c.group.padEnd(7)}] ${c.query.padEnd(24)} ${ranks}`);
    if (status !== "PASS") lines.push(`            top: ${top}${c.note ? `\n            note: ${c.note}` : ""}`);
  }

  console.log(`\nCurator eval — ${cases.length} queries against ${(await index.list()).filter((r) => r.draft.state === "approved").length} approved works (${provider.name})\n`);
  console.log(`  top-1: ${top1}/${cases.length}    exact top-k: ${topK}/${cases.length}\n`);
  for (const [group, g] of byGroup) console.log(`  ${group.padEnd(8)} ${g.top1}/${g.n}`);
  console.log();
  console.log(lines.join("\n"));
  console.log();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
