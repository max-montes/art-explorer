import { Pool } from "pg";
import {
  assetAssociations,
  type AssetVectors,
  type Concept,
  type ConceptEdge,
  type MediaAsset,
  type ScoredAsset,
} from "@/lib/catalog/types";
import type {
  CatalogIndexEntry,
  CatalogRepository,
  VectorQuery,
} from "./repository";

const toVector = (values: number[]) => `[${values.join(",")}]`;

interface SearchRow {
  catalog_payload: MediaAsset;
  score: number;
  semantic_score: number;
  metadata_score: number;
  image_score: number | null;
  matched_label: string | null;
}

export class PostgresCatalogRepository implements CatalogRepository {
  constructor(private readonly pool: Pool) {}

  async prepare(): Promise<void> {
    const result = await this.pool.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.media_embeddings')::text AS table_name",
    );
    if (!result.rows[0]?.table_name) {
      throw new Error(
        "PostgreSQL catalog is not initialized. Run Docker Compose so db/schema.sql is applied.",
      );
    }
  }

  async findAsset(id: string): Promise<MediaAsset | null> {
    const result = await this.pool.query<{ catalog_payload: MediaAsset }>(
      "SELECT catalog_payload FROM media_assets WHERE id = $1",
      [id],
    );
    return result.rows[0]?.catalog_payload ?? null;
  }

  async findAssetVectors(id: string): Promise<AssetVectors | null> {
    const [embedding, labels] = await Promise.all([
      this.pool.query<{ semantic: string; metadata: string; image: string | null }>(
        `SELECT semantic_embedding::text AS semantic,
                metadata_embedding::text AS metadata,
                image_embedding::text AS image
           FROM media_embeddings
          WHERE asset_id = $1`,
        [id],
      ),
      this.pool.query<{ embedding: string }>(
        `SELECT embedding::text AS embedding
           FROM asset_label_embeddings
          WHERE asset_id = $1
          ORDER BY position`,
        [id],
      ),
    ]);
    const row = embedding.rows[0];
    if (!row) return null;
    return {
      semantic: this.parseVector(row.semantic),
      metadata: this.parseVector(row.metadata),
      ...(row.image ? { image: this.parseVector(row.image) } : {}),
      ...(labels.rows.length
        ? { labels: labels.rows.map((r) => this.parseVector(r.embedding)) }
        : {}),
    };
  }

  /**
   * Label mode mirrors `semanticScore`: best label similarity plus a small
   * bonus for other labels above the floor. Assets without label rows (older
   * records) fall back to the whole-list vector via COALESCE.
   */
  async search(query: VectorQuery): Promise<ScoredAsset[]> {
    const mode = query.mode ?? "labels";
    // Mirrors semanticScore: best label + min(0.08, 0.6 * Σ(s - 0.7·best))
    // over the other labels scoring above 70% of the best.
    const semanticExpression =
      mode === "whole"
        ? `1 - (embedding.semantic_embedding <=> $1::vector)`
        : `COALESCE(
             (SELECT LEAST(1, b.best + LEAST(0.08, 0.6 * COALESCE(
                (SELECT SUM(s.sim - 0.7 * b.best)
                   FROM (SELECT 1 - (l.embedding <=> $1::vector) AS sim
                           FROM asset_label_embeddings l WHERE l.asset_id = asset.id) s
                  WHERE s.sim > 0.7 * b.best AND s.sim < b.best), 0)))
                FROM (SELECT MAX(1 - (l.embedding <=> $1::vector)) AS best
                        FROM asset_label_embeddings l WHERE l.asset_id = asset.id) b
               WHERE b.best IS NOT NULL),
             1 - (embedding.semantic_embedding <=> $1::vector))`;
    const result = await this.pool.query<SearchRow>(
      `SELECT asset.catalog_payload,
              ${semanticExpression} AS semantic_score,
              1 - (embedding.metadata_embedding <=> $2::vector) AS metadata_score,
              CASE WHEN $8::vector IS NULL OR embedding.image_embedding IS NULL
                       THEN 0
                       ELSE 1 - (embedding.image_embedding <=> $8::vector)
                  END AS image_score,
              (${semanticExpression}) * $3
                + (1 - (embedding.metadata_embedding <=> $2::vector)) * $4
                + CASE WHEN $8::vector IS NULL OR embedding.image_embedding IS NULL
                       THEN 0
                       ELSE (1 - (embedding.image_embedding <=> $8::vector)) * $9
                  END AS score,
              (SELECT l.label FROM asset_label_embeddings l
                WHERE l.asset_id = asset.id
                ORDER BY l.embedding <=> $1::vector
                LIMIT 1) AS matched_label
         FROM media_embeddings embedding
         JOIN media_assets asset ON asset.id = embedding.asset_id
        WHERE ($5::text IS NULL OR asset.id <> $5)
          AND asset.library_category = $7
        ORDER BY score DESC
        LIMIT $6`,
      [
        toVector(query.vectors.semantic),
        toVector(query.vectors.metadata),
        query.weights.semantic,
        query.weights.metadata,
        query.excludeAssetId ?? null,
        query.limit,
        query.channel,
        query.imageVector ? toVector(query.imageVector) : null,
        query.weights.image ?? 0,
      ],
    );
    return result.rows.map((row) => ({
      asset: row.catalog_payload,
      score: Number(row.score),
      scores: {
        semantic: Number(row.semantic_score),
        metadata: Number(row.metadata_score),
        ...(row.image_score !== null ? { image: Number(row.image_score) } : {}),
      },
      ...(mode === "labels" && row.matched_label
        ? { matchedLabel: row.matched_label }
        : {}),
    }));
  }

  async concepts(): Promise<Concept[]> {
    const result = await this.pool.query<{
      id: string;
      label: string;
      description: string;
      aliases: string[];
    }>("SELECT id, label, description, aliases FROM concepts ORDER BY label");
    return result.rows;
  }

  async conceptEdges(): Promise<ConceptEdge[]> {
    const result = await this.pool.query<ConceptEdge>(
      `SELECT source_concept_id AS "from",
              target_concept_id AS "to",
              relation
         FROM concept_edges`,
    );
    return result.rows;
  }

  async upsertIndexedAsset(entry: CatalogIndexEntry): Promise<void> {
    await this.upsertIndexedAssets([entry]);
  }

  async upsertIndexedAssets(entries: CatalogIndexEntry[]): Promise<void> {
    if (!entries.length) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of entries) {
        const { asset, documents, vectors } = entry;
        await client.query(
        `INSERT INTO media_assets (
          id, media_type, library_category, title, creator, year_display, description, narrative,
           curator_notes, source_provider, source_url, media_url, license,
           license_url, owner_id, catalog_payload
         ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
         )
         ON CONFLICT (id) DO UPDATE SET
           media_type = EXCLUDED.media_type,
           library_category = EXCLUDED.library_category,
           title = EXCLUDED.title,
           creator = EXCLUDED.creator,
           year_display = EXCLUDED.year_display,
           description = EXCLUDED.description,
           narrative = EXCLUDED.narrative,
           curator_notes = EXCLUDED.curator_notes,
           source_provider = EXCLUDED.source_provider,
           source_url = EXCLUDED.source_url,
           media_url = EXCLUDED.media_url,
           license = EXCLUDED.license,
           license_url = EXCLUDED.license_url,
           owner_id = EXCLUDED.owner_id,
           catalog_payload = EXCLUDED.catalog_payload,
           updated_at = now()`,
        [
          asset.id,
          asset.type,
          asset.libraryCategory ?? "artwork",
          asset.title,
          asset.creator,
          asset.year,
          asset.semantics.description,
          asset.semantics.narrative,
          asset.semantics.curatorNotes ?? null,
          asset.source.provider,
          asset.source.sourceUrl,
          asset.source.mediaUrl ?? null,
          asset.source.license,
          asset.source.licenseUrl ?? null,
          asset.ownerId ?? null,
          asset,
        ],
        );
        await client.query("DELETE FROM asset_labels WHERE asset_id = $1", [
          asset.id,
        ]);
        const labels = [
          ...(asset.semantics.associations ?? []).map((label) => [
            "association",
            label,
          ]),
          ...asset.semantics.concepts.map((label) => ["concept", label]),
          ...asset.semantics.moods.map((label) => ["mood", label]),
          ...asset.semantics.subjects.map((label) => ["subject", label]),
        ];
        for (const [type, label] of labels) {
          await client.query(
            `INSERT INTO asset_labels (asset_id, label_type, label)
             VALUES ($1, $2, $3)`,
            [asset.id, type, label],
          );
        }
        await client.query(
        `INSERT INTO media_embeddings (
           asset_id, model_name, document_version, semantic_document,
           metadata_document, semantic_embedding, metadata_embedding, image_embedding
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (asset_id) DO UPDATE SET
           model_name = EXCLUDED.model_name,
           document_version = EXCLUDED.document_version,
           semantic_document = EXCLUDED.semantic_document,
           metadata_document = EXCLUDED.metadata_document,
           semantic_embedding = EXCLUDED.semantic_embedding,
           metadata_embedding = EXCLUDED.metadata_embedding,
           image_embedding = EXCLUDED.image_embedding,
           embedded_at = now()`,
        [
          asset.id,
          entry.provider,
          entry.documentVersion,
          documents.semantic,
          documents.metadata,
          toVector(vectors.semantic),
          toVector(vectors.metadata),
          vectors.image ? toVector(vectors.image) : null,
        ],
        );
        await client.query(
          "DELETE FROM asset_label_embeddings WHERE asset_id = $1",
          [asset.id],
        );
        if (vectors.labels?.length) {
          const associationLabels = assetAssociations(asset);
          for (
            let i = 0;
            i < vectors.labels.length && i < associationLabels.length;
            i++
          ) {
            await client.query(
              `INSERT INTO asset_label_embeddings (asset_id, position, label, embedding)
               VALUES ($1, $2, $3, $4)`,
              [asset.id, i, associationLabels[i], toVector(vectors.labels[i])],
            );
          }
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async removeIndexedAsset(id: string): Promise<void> {
    await this.pool.query("DELETE FROM media_assets WHERE id = $1", [id]);
  }

  private parseVector(value: string) {
    return value
      .slice(1, -1)
      .split(",")
      .map((component) => Number(component));
  }
}
