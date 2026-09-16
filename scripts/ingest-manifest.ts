import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  approvedManifestEntries,
  parseCurationManifest,
  type CurationManifestEntry,
} from "../src/lib/catalog/manifest";
import type { MediaAsset } from "../src/lib/catalog/types";
import { embedAsset } from "../src/lib/retrieval/documents";
import { PostgresCatalogRepository } from "../src/lib/retrieval/postgres-repository";
import { createEmbeddingProvider } from "../src/lib/retrieval/providers";

async function main() {
  const manifestPath = process.argv[2] ?? process.env.CURATION_MANIFEST;
  if (!manifestPath) {
    throw new Error(
      "Pass an explicit manifest path: npm run catalog:ingest -- curation/catalog.local.json",
    );
  }

  const rawManifest = await readFile(path.resolve(manifestPath), "utf8");
  const manifest = parseCurationManifest(JSON.parse(rawManifest));
  const approved = approvedManifestEntries(manifest);
  const provider = createEmbeddingProvider();
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "******localhost:5432/art_explorer",
  });
  const repository = new PostgresCatalogRepository(pool);
  await repository.prepare();
  const client = await pool.connect();

  async function recordDecision(
    database: PoolClient,
    entry: CurationManifestEntry,
    assetId: string | null,
  ) {
    const sourcePath = path.resolve(manifest.source_root, entry.source_path);
    await database.query(
      `INSERT INTO curation_decisions (
       manifest_version, entry_id, source_path, decision, exclusion_reason,
       review_reason, metadata_status, license_review_status, asset_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (entry_id) DO UPDATE SET
       manifest_version = EXCLUDED.manifest_version,
       source_path = EXCLUDED.source_path,
       decision = EXCLUDED.decision,
       exclusion_reason = EXCLUDED.exclusion_reason,
       review_reason = EXCLUDED.review_reason,
       metadata_status = EXCLUDED.metadata_status,
       license_review_status = EXCLUDED.license_review_status,
       asset_id = EXCLUDED.asset_id,
       reviewed_at = now()`,
      [
        manifest.version,
        entry.id,
        sourcePath,
        entry.decision,
        entry.exclusion_reason,
        entry.review_reason ?? null,
        entry.metadata_status,
        entry.license_review_status,
        assetId,
      ],
    );
  }

  async function upsertAsset(asset: MediaAsset) {
    const { documents, vectors } = await embedAsset(asset, provider);
    if (vectors.semantic.length !== 384) {
      throw new Error("The catalog schema requires 384-dimensional embeddings.");
    }
    await repository.upsertIndexedAsset({
      asset,
      documents,
      vectors,
      provider: provider.name,
      documentVersion: 1,
    });
  }

  try {
    await client.query("BEGIN");
    const approvedByEntryId = new Map(
      approved.map((entry) => [entry.id, entry.asset]),
    );
    for (const entry of manifest.entries) {
      const asset = approvedByEntryId.get(entry.id);
      if (asset) await upsertAsset(asset);
      await recordDecision(client, entry, asset?.id ?? null);
    }
    await client.query("COMMIT");
    console.log(
      `Recorded ${manifest.entries.length} decisions; imported ${approved.length} approved assets.`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
