import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  isRijksPainting,
  mapRijksPainting,
  type RijksArtwork,
} from "../src/lib/catalog/rijksmuseum";

const SEARCH_URL = "https://data.rijksmuseum.nl/search/collection";
const RECORD_URL =
  "https://data.rijksmuseum.nl/oai?verb=GetRecord&metadataPrefix=edm&identifier=";
const CONCURRENCY = 8;
const MAX_RETRIES = 4;

type XmlNode = Record<string, unknown>;

interface SearchPage {
  next?: { id?: string };
  orderedItems?: Array<{ id?: string }>;
  partOf?: { totalItems?: number };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
});

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const node = (value: unknown): XmlNode =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlNode)
    : {};

const attribute = (value: unknown, name: string) => {
  const result = node(value)[name];
  return typeof result === "string" ? result : "";
};

const decodeEntities = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    );

const localized = (value: unknown) => {
  if (typeof value === "string" || typeof value === "number") {
    return decodeEntities(String(value));
  }
  const values = array(value).map(node);
  const preferred =
    values.find((item) => item["@xml:lang"] === "en") ??
    values.find((item) => item["@xml:lang"] === "nl") ??
    values[0];
  const text = preferred?.["#text"] ?? preferred;
  return typeof text === "string" || typeof text === "number"
    ? decodeEntities(String(text))
    : "";
};

const resources = (value: unknown) =>
  array(value)
    .map((item) => attribute(item, "@rdf:resource"))
    .filter(Boolean);

async function fetchText(url: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Rijksmuseum API returned HTTP ${response.status}.`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(250 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Rijksmuseum API request failed.");
}

async function fetchIds(limit: number) {
  const ids: string[] = [];
  let url = `${SEARCH_URL}?type=painting`;
  let total = 0;
  while (url) {
    const page = JSON.parse(await fetchText(url)) as SearchPage;
    total = page.partOf?.totalItems ?? total;
    for (const item of page.orderedItems ?? []) {
      if (item.id) ids.push(item.id);
      if (limit && ids.length >= limit) return ids;
    }
    console.log(`[Rijksmuseum] discovered ${ids.length}/${total} records`);
    url = page.next?.id ?? "";
  }
  return ids;
}

function parseArtwork(xml: string): RijksArtwork | null {
  const document = parser.parse(xml) as XmlNode;
  const oai = node(document["OAI-PMH"]);
  const record = node(node(oai["GetRecord"])["record"]);
  const metadata = node(record["metadata"]);
  const graph = node(metadata["rdf:RDF"]);
  const aggregation = node(graph["ore:Aggregation"]);
  const artwork = node(graph["edm:ProvidedCHO"]);
  if (!Object.keys(artwork).length) return null;

  const agents = new Map(
    array(graph["edm:Agent"]).map((entry) => {
      const item = node(entry);
      return [attribute(item, "@rdf:about"), localized(item["skos:prefLabel"])];
    }),
  );
  const concepts = new Map(
    array(graph["skos:Concept"]).map((entry) => {
      const item = node(entry);
      return [attribute(item, "@rdf:about"), localized(item["skos:prefLabel"])];
    }),
  );
  const creator = resources(artwork["dc:creator"])
    .map((id) => agents.get(id))
    .filter(Boolean)
    .join("; ");
  const subjects = resources(artwork["dc:subject"])
    .map((id) => concepts.get(id))
    .filter((value): value is string => Boolean(value));
  const materials = resources(artwork["dcterms:medium"])
    .map((id) => concepts.get(id))
    .filter((value): value is string => Boolean(value));
  const id = attribute(artwork, "@rdf:about").split("/").at(-1) ?? "";

  return {
    id,
    objectNumber: localized(artwork["dc:identifier"]),
    title: localized(artwork["dc:title"]),
    creator,
    date: localized(artwork["dcterms:created"]),
    description: localized(artwork["dc:description"]) || undefined,
    subjects,
    materials,
    sourceUrl: attribute(aggregation["edm:isShownAt"], "@rdf:resource"),
    imageUrl: attribute(aggregation["edm:isShownBy"], "@rdf:resource"),
    rightsUrl: attribute(aggregation["edm:rights"], "@rdf:resource"),
  };
}

async function main() {
  const output = argument("--output");
  if (!output) {
    throw new Error(
      "Pass an output path: npm run catalog:rijks -- --output curation/rijks.json",
    );
  }
  const requestedLimit = Number(argument("--limit") ?? 0);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 0) {
    throw new Error("--limit must be a non-negative integer.");
  }

  const ids = await fetchIds(requestedLimit);
  const entries = [];
  for (let start = 0; start < ids.length; start += CONCURRENCY) {
    const batch = ids.slice(start, start + CONCURRENCY);
    const records = await Promise.all(
      batch.map(async (id) =>
        parseArtwork(await fetchText(`${RECORD_URL}${encodeURIComponent(id)}`)),
      ),
    );
    for (const record of records) {
      if (!record || !isRijksPainting(record)) continue;
      const asset = mapRijksPainting(record);
      entries.push({
        id: asset.id,
        source_path: `rijks/${record.objectNumber || record.id}.jpg`,
        decision: "include" as const,
        exclusion_reason: null,
        metadata_status: "complete" as const,
        license_review_status: "approved" as const,
        asset,
      });
    }
    if (
      start === 0 ||
      start + CONCURRENCY >= ids.length ||
      (start + CONCURRENCY) % 200 === 0
    ) {
      console.log(
        `[Rijksmuseum] processed ${Math.min(start + CONCURRENCY, ids.length)}/` +
          `${ids.length}; ${entries.length} paintings accepted`,
      );
    }
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
  console.log(`Wrote ${entries.length} Rijksmuseum paintings to ${outputPath}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
