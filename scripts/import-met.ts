import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isArtworkObject,
  mapMetObject,
  MetObjectNotFoundError,
  isMetObject,
  normalizeMetQueries,
  mergeMetObjectIDs,
  type MetObject,
} from "../src/lib/catalog/met";

const API_ROOT = "https://collectionapi.metmuseum.org/public/collection/v1";
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 3;

interface SearchResponse {
  objectIDs?: unknown;
}

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repeatedArgument = (name: string) =>
  process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );

const outputPath = argument("--output");
const queries = normalizeMetQueries(repeatedArgument("--query"));
const limitValue = argument("--limit");
const limit = limitValue === undefined ? 25 : Number(limitValue);

if (!outputPath) {
  throw new Error(
    "Pass an output path: npm run catalog:met -- --output curation/met.json [--limit 25]",
  );
}
const requiredOutputPath = outputPath;
if (!Number.isInteger(limit) || limit < 1) {
  throw new Error("--limit must be a positive integer.");
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson<T>(url: string, objectID?: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === 404 && objectID !== undefined) {
        throw new MetObjectNotFoundError(objectID);
      }
      if (!response.ok) {
        throw new Error(`Met API returned HTTP ${response.status} for ${url}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof MetObjectNotFoundError) {
        throw error;
      }
      lastError = error;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(REQUEST_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Met API request failed.");
}

async function main() {
  const searchIDGroups: unknown[] = [];
  for (const query of queries) {
    const search = await fetchJson<SearchResponse>(
      `${API_ROOT}/search?hasImages=true&isPublicDomain=true&q=${encodeURIComponent(query)}`,
    );
    searchIDGroups.push(search.objectIDs);
  }
  const candidateIds = mergeMetObjectIDs(searchIDGroups);
  const entries = [];
  let skippedNotFound = 0;
  let skippedInvalid = 0;

  for (const objectID of candidateIds) {
    if (
      entries.filter((entry) => entry.decision === "include").length >= limit
    ) {
      break;
    }
    let object: MetObject | undefined;
    try {
      object = await fetchJson<MetObject>(
        `${API_ROOT}/objects/${objectID}`,
        objectID,
      );
    } catch (error) {
      if (error instanceof MetObjectNotFoundError) {
        skippedNotFound += 1;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      if (!object || !isMetObject(object)) {
        skippedInvalid += 1;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      throw error;
    }
    if (isArtworkObject(object)) {
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
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const resolvedOutput = path.resolve(requiredOutputPath);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(
    resolvedOutput,
    `${JSON.stringify(
      {
        version: 1,
        source_root: path.dirname(resolvedOutput),
        entries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `Wrote ${entries.length} Met artwork entries to ${resolvedOutput} ` +
      `(queries: ${queries.join(", ")}, skipped ${skippedNotFound} retired, ` +
      `${skippedInvalid} malformed objects).`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
