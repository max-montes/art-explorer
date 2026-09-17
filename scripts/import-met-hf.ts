import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isPaintingObject,
  mapMetObject,
  type MetObject,
} from "../src/lib/catalog/met";

const ROWS_API =
  "https://datasets-server.huggingface.co/rows?dataset=metmuseum%2Fopenaccess" +
  "&config=default&split=train";
const PAGE_SIZE = 100;

interface HuggingFaceRow {
  row: Record<string, unknown>;
}

interface HuggingFaceResponse {
  rows?: HuggingFaceRow[];
  num_rows_total?: number;
}

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const outputPath = argument("--output");
const limitValue = argument("--limit");
const limit = limitValue === undefined ? 100 : Number(limitValue);
const offsetValue = argument("--offset");
const initialOffset = offsetValue === undefined ? 0 : Number(offsetValue);

if (!outputPath) {
  throw new Error(
    "Pass an output path: npm run catalog:met:hf -- --output curation/met-hf.json",
  );
}
const requiredOutputPath = outputPath;
if (!Number.isInteger(limit) || limit < 1) {
  throw new Error("--limit must be a positive integer.");
}
if (!Number.isInteger(initialOffset) || initialOffset < 0) {
  throw new Error("--offset must be a non-negative integer.");
}

const asString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const toMetObject = (row: Record<string, unknown>): MetObject | null => {
  const objectID = row.objectID;
  const image = row.image;
  const imageUrl =
    image && typeof image === "object" && "src" in image
      ? asString((image as { src?: unknown }).src)
      : asString(row.primaryImageSmall);
  const objectUrl = asString(row.objectURL);
  if (
    typeof objectID !== "number" ||
    !Number.isInteger(objectID) ||
    typeof row.isPublicDomain !== "boolean" ||
    !imageUrl ||
    !objectUrl
  ) {
    return null;
  }
  return {
    objectID,
    isPublicDomain: row.isPublicDomain,
    objectURL: objectUrl,
    primaryImage: imageUrl,
    primaryImageSmall: asString(row.primaryImageSmall),
    title: asString(row.title),
    objectName: asString(row.objectName),
    department: asString(row.department),
    classification: asString(row.classification),
    artistDisplayName: asString(row.artistDisplayName),
    artistDisplayBio: asString(row.artistDisplayBio),
    objectDate: asString(row.objectDate),
    culture: asString(row.culture),
    medium: asString(row.medium),
  };
};

async function fetchPage(offset: number): Promise<HuggingFaceResponse> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(
      `${ROWS_API}&offset=${offset}&length=${PAGE_SIZE}`,
    );
    if (response.ok) return (await response.json()) as HuggingFaceResponse;
    lastStatus = response.status;
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  throw new Error(`Hugging Face rows API returned HTTP ${lastStatus}.`);
}

async function main() {
  const entries: unknown[] = [];
  let offset = initialOffset;
  let scanned = 0;
  let total = Number.POSITIVE_INFINITY;
  const startedAt = Date.now();
  const resolvedOutput = path.resolve(requiredOutputPath);
  const partialOutput = `${resolvedOutput}.partial.json`;

  const writeCheckpoint = async () => {
    await mkdir(path.dirname(partialOutput), { recursive: true });
    await writeFile(
      partialOutput,
      `${JSON.stringify(
        {
          version: 1,
          source_root: path.dirname(resolvedOutput),
          offset,
          scanned,
          entries,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  while (entries.length < limit && offset < total) {
    let page: HuggingFaceResponse;
    try {
      page = await fetchPage(offset);
    } catch (error) {
      console.warn(
        `[Met HF] skipping unavailable page at offset ${offset}:`,
        error,
      );
      await writeCheckpoint();
      offset += PAGE_SIZE;
      continue;
    }
    const rows = page.rows ?? [];
    total = page.num_rows_total ?? offset + rows.length;
    if (!rows.length) break;

    for (const { row } of rows) {
      scanned += 1;
      const object = toMetObject(row);
      if (!object || !isPaintingObject(object)) continue;
      const asset = mapMetObject(object);
      entries.push({
        id: asset.id,
        source_path: `met/${object.objectID}.jpg`,
        decision: "include" as const,
        exclusion_reason: null,
        metadata_status: "complete" as const,
        license_review_status: "approved" as const,
        asset,
      });
      if (entries.length >= limit) break;
    }

    offset += rows.length;
    await writeCheckpoint();
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const rowsPerSecond = scanned / elapsedSeconds;
    const remainingRows = Math.max(0, total - offset);
    const etaSeconds =
      rowsPerSecond > 0 ? remainingRows / rowsPerSecond : Number.POSITIVE_INFINITY;
    console.log(
      `[Met HF] scanned ${scanned}/${total}; accepted ${entries.length}; ` +
        `${rowsPerSecond.toFixed(1)} rows/s; ETA ${Number.isFinite(etaSeconds) ? `${Math.ceil(etaSeconds)}s` : "unknown"}`,
    );
  }

  if (entries.length < limit) {
    throw new Error(
      `Only found ${entries.length} qualifying records after scanning ${scanned} rows.`,
    );
  }

  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(
    resolvedOutput,
    `${JSON.stringify(
      { version: 1, source_root: path.dirname(resolvedOutput), entries },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await unlink(partialOutput).catch(() => undefined);
  console.log(`Wrote ${entries.length} Met HF entries to ${resolvedOutput}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
