import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isSmkPainting,
  mapSmkArtwork,
  SMK_PAINTING_DEPARTMENT,
  type SmkArtwork,
} from "../src/lib/catalog/smk";

const API_URL = "https://api.smk.dk/api/v1/art/search/";
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 250;
const MAX_RETRIES = 4;

interface SmkResponse {
  found?: number;
  items?: SmkArtwork[];
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function fetchPage(offset: number): Promise<SmkResponse> {
  const query = new URLSearchParams({
    keys: "*",
    rows: String(PAGE_SIZE),
    offset: String(offset),
    filters:
      "[has_image:true],[object_names:maleri],[public_domain:true]," +
      `[responsible_department:${SMK_PAINTING_DEPARTMENT}]`,
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${API_URL}?${query}`);
      if (!response.ok) {
        throw new Error(`SMK API returned HTTP ${response.status}.`);
      }
      return (await response.json()) as SmkResponse;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(REQUEST_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("SMK API request failed.");
}

async function main() {
  const output = argument("--output");
  if (!output) {
    throw new Error(
      "Pass an output path: npm run catalog:smk -- --output curation/smk.json",
    );
  }
  const requestedLimit = Number(argument("--limit") ?? 0);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 0) {
    throw new Error("--limit must be a non-negative integer.");
  }

  const entries = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 1;
  while (offset < total) {
    const response = await fetchPage(offset);
    total = response.found ?? 0;
    for (const candidate of response.items ?? []) {
      if (!isSmkPainting(candidate)) continue;
      const objectNumber = candidate.object_number?.trim() ?? "";
      if (seen.has(objectNumber)) continue;
      seen.add(objectNumber);
      const asset = mapSmkArtwork(candidate);
      entries.push({
        id: asset.id,
        source_path: `smk/${objectNumber}.jpg`,
        decision: "include" as const,
        exclusion_reason: null,
        metadata_status: "complete" as const,
        license_review_status: "approved" as const,
        asset,
      });
      if (requestedLimit && entries.length >= requestedLimit) break;
    }
    console.log(
      `[SMK] ${Math.min(offset + PAGE_SIZE, total)}/${total}; ` +
        `${entries.length} paintings accepted`,
    );
    if (requestedLimit && entries.length >= requestedLimit) break;
    offset += PAGE_SIZE;
    if (offset < total) await sleep(REQUEST_DELAY_MS);
  }

  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        source_root: path.dirname(outputPath),
        entries,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${entries.length} SMK paintings to ${outputPath}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
