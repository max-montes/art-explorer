import { readFile } from "node:fs/promises";
import path from "node:path";

type Judgment = "relevant" | "unsure" | "not_relevant";
type ModelName = "siglip768" | "jina256";

interface EvalLabel {
  query: string;
  assetId: string;
  label: Judgment;
  title: string;
  rankingMethod: string;
}

interface LabelExport {
  labels: EvalLabel[];
}

interface RankingEntry {
  assetId: string;
  score: number;
}

interface KeyQuery {
  query: string;
  group: string;
  rankings: Record<ModelName, RankingEntry[]>;
}

interface EvalKey {
  id: string;
  queries: KeyQuery[];
}

interface Metrics {
  strictPrecision: number;
  lenientPrecision: number;
  strictNdcg: number | null;
  lenientNdcg: number | null;
}

const MODELS: ModelName[] = ["siglip768", "jina256"];

const gain = (label: Judgment, lenient: boolean) =>
  label === "relevant" ? 1 : label === "unsure" && lenient ? 0.5 : 0;

const dcg = (grades: number[]) =>
  grades.reduce(
    (sum, grade, index) => sum + grade / Math.log2(index + 2),
    0,
  );

const ndcg = (
  labels: Judgment[],
  idealLabels: Judgment[],
  lenient: boolean,
) => {
  const grades = labels.map((label) => gain(label, lenient));
  const ideal = dcg(
    idealLabels
      .map((label) => gain(label, lenient))
      .sort((left, right) => right - left)
      .slice(0, labels.length),
  );
  return ideal === 0 ? null : dcg(grades) / ideal;
};

const metrics = (
  labels: Judgment[],
  idealLabels: Judgment[],
): Metrics => ({
  strictPrecision:
    labels.reduce((sum, label) => sum + gain(label, false), 0) / labels.length,
  lenientPrecision:
    labels.reduce((sum, label) => sum + gain(label, true), 0) / labels.length,
  strictNdcg: ndcg(labels, idealLabels, false),
  lenientNdcg: ndcg(labels, idealLabels, true),
});

const mean = (values: Array<number | null>) => {
  const present = values.filter((value): value is number => value !== null);
  return present.length
    ? present.reduce((sum, value) => sum + value, 0) / present.length
    : null;
};

const summarize = (values: Metrics[]): Metrics => ({
  strictPrecision: mean(values.map((value) => value.strictPrecision)) ?? 0,
  lenientPrecision: mean(values.map((value) => value.lenientPrecision)) ?? 0,
  strictNdcg: mean(values.map((value) => value.strictNdcg)),
  lenientNdcg: mean(values.map((value) => value.lenientNdcg)),
});

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const decimal = (value: number | null) =>
  value === null ? "n/a" : value.toFixed(3);

async function main() {
  const labelsPath = process.argv[2];
  if (!labelsPath) {
    throw new Error(
      "Pass a blinded label export: npx tsx scripts/score-image-model-eval.ts /path/to/labels.json",
    );
  }
  const keyPath = path.resolve(
    process.argv[3] ??
      ".cache/image-model-eval/prospective-key.json",
  );
  const [labelExport, key] = await Promise.all([
    readFile(labelsPath, "utf8").then(
      (value) => JSON.parse(value) as LabelExport,
    ),
    readFile(keyPath, "utf8").then(
      (value) => JSON.parse(value) as EvalKey,
    ),
  ]);
  const evaluationMethod = `blind:${key.id}`;
  const labels = labelExport.labels.filter(
    ({ rankingMethod }) => rankingMethod === evaluationMethod,
  );
  const judgments = new Map(
    labels.map((label) => [`${label.query}:${label.assetId}`, label]),
  );

  const byModel = new Map<ModelName, Map<string, Metrics>>(
    MODELS.map((model) => [model, new Map()]),
  );
  const repeated = new Map<
    string,
    { title: string; appearances: Set<string>; judgments: Judgment[] }
  >();

  console.log("| Query | Group | SigLIP P@5 | Jina P@5 | SigLIP nDCG | Jina nDCG |");
  console.log("|---|---|---:|---:|---:|---:|");
  for (const query of key.queries) {
    const idealLabels = labels
      .filter((label) => label.query === query.query)
      .map(({ label }) => label);
    const queryMetrics = new Map<ModelName, Metrics>();
    for (const model of MODELS) {
      const rankedLabels = query.rankings[model].map(({ assetId }) => {
        const label = judgments.get(`${query.query}:${assetId}`);
        if (!label) {
          throw new Error(
            `Missing judgment for "${query.query}" candidate ${assetId}.`,
          );
        }
        const frequency = repeated.get(assetId) ?? {
          title: label.title,
          appearances: new Set<string>(),
          judgments: [],
        };
        frequency.appearances.add(`${query.query}:${model}`);
        frequency.judgments.push(label.label);
        repeated.set(assetId, frequency);
        return label.label;
      });
      const result = metrics(rankedLabels, idealLabels);
      queryMetrics.set(model, result);
      byModel.get(model)?.set(query.query, result);
    }
    const siglip = queryMetrics.get("siglip768");
    const jina = queryMetrics.get("jina256");
    if (!siglip || !jina) throw new Error("Incomplete model metrics.");
    console.log(
      `| ${query.query} | ${query.group} | ${percent(siglip.strictPrecision)} (${percent(siglip.lenientPrecision)}) | ` +
        `${percent(jina.strictPrecision)} (${percent(jina.lenientPrecision)}) | ` +
        `${decimal(siglip.strictNdcg)} (${decimal(siglip.lenientNdcg)}) | ` +
        `${decimal(jina.strictNdcg)} (${decimal(jina.lenientNdcg)}) |`,
    );
  }

  console.log("\nOverall macro metrics (strict; lenient in parentheses)");
  for (const model of MODELS) {
    const aggregate = summarize([...(byModel.get(model)?.values() ?? [])]);
    console.log(
      `  ${model.padEnd(10)} P@5 ${percent(aggregate.strictPrecision)} (${percent(aggregate.lenientPrecision)})  ` +
        `nDCG ${decimal(aggregate.strictNdcg)} (${decimal(aggregate.lenientNdcg)})`,
    );
  }

  console.log("\nMetrics by category");
  const groups = [...new Set(key.queries.map(({ group }) => group))];
  for (const group of groups) {
    const groupQueries = new Set(
      key.queries
        .filter((query) => query.group === group)
        .map(({ query }) => query),
    );
    const summaries = MODELS.map((model) => {
      const values = [
        ...(byModel.get(model)?.entries() ?? []),
      ]
        .filter(([query]) => groupQueries.has(query))
        .map(([, value]) => value);
      const aggregate = summarize(values);
      return `${model} ${percent(aggregate.strictPrecision)}/${percent(aggregate.lenientPrecision)}`;
    });
    console.log(`  ${group.padEnd(18)} ${summaries.join("  ")}`);
  }

  let siglipWins = 0;
  let jinaWins = 0;
  let ties = 0;
  for (const { query } of key.queries) {
    const siglip = byModel.get("siglip768")?.get(query);
    const jina = byModel.get("jina256")?.get(query);
    if (!siglip || !jina) continue;
    if (siglip.strictPrecision > jina.strictPrecision) siglipWins += 1;
    else if (jina.strictPrecision > siglip.strictPrecision) jinaWins += 1;
    else ties += 1;
  }
  console.log(
    `\nStrict P@5 wins: Jina ${jinaWins}, SigLIP ${siglipWins}, ties ${ties}.`,
  );

  console.log("\nRepeated candidates");
  for (const [assetId, value] of [...repeated]
    .filter(([, value]) => value.appearances.size >= 3)
    .sort(
      (left, right) =>
        right[1].appearances.size - left[1].appearances.size,
    )) {
    const uniqueJudgments = [
      ...new Set(
        key.queries.flatMap(({ query }) => {
          const label = judgments.get(`${query}:${assetId}`);
          return label ? [label.label] : [];
        }),
      ),
    ];
    console.log(
      `  ${value.appearances.size} model-query appearances  ${assetId}  ${value.title}  ` +
        `judged ${uniqueJudgments.join("/")}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
