import { Pool } from "pg";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalHealth = globalThis as typeof globalThis & {
  healthPool?: Pool;
};

function pool() {
  if (!globalHealth.healthPool) {
    globalHealth.healthPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
  }
  return globalHealth.healthPool;
}

export async function GET() {
  if ((process.env.CATALOG_REPOSITORY ?? "memory") !== "postgres") {
    return NextResponse.json({ status: "ok", repository: "memory" });
  }
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { status: "error", error: "DATABASE_URL is not configured." },
      { status: 503 },
    );
  }

  try {
    const result = await pool().query<{
      assets: string;
      jina_images: string;
    }>(
      `SELECT count(*)::text AS assets,
              count(embedding.jina_image_embedding)::text AS jina_images
         FROM media_assets asset
         LEFT JOIN media_embeddings embedding
           ON embedding.asset_id = asset.id`,
    );
    const assets = Number(result.rows[0]?.assets ?? 0);
    const jinaImages = Number(result.rows[0]?.jina_images ?? 0);
    const ready = assets > 0 && jinaImages > 0;
    return NextResponse.json(
      {
        status: ready ? "ok" : "degraded",
        repository: "postgres",
        assets,
        jinaImages,
      },
      { status: ready ? 200 : 503 },
    );
  } catch (error) {
    console.error("[Health] Database check failed.", error);
    return NextResponse.json(
      {
        status: "error",
        error: "Database unavailable.",
      },
      { status: 503 },
    );
  }
}
