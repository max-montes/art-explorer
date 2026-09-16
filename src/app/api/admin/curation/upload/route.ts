import { NextResponse } from "next/server";
import { getCuratorService } from "@/lib/curation/container";
import { isLocalFeatureRequest } from "@/lib/curation/local-security";
import type { CuratorIndexRecord } from "@/lib/curation/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const clientRecord = (record: CuratorIndexRecord) => ({
  ...record,
  embedding: {
    status: record.embedding.status,
    provider: record.embedding.provider,
    version: record.embedding.version,
    indexedAt: record.embedding.indexedAt,
  },
});

export async function POST(request: Request) {
  if (!isLocalFeatureRequest(request)) {
    return NextResponse.json(
      { error: "The curator API is disabled outside local development." },
      { status: 403 },
    );
  }
  try {
    const form = await request.formData();
    const files = form.getAll("files");
    if (
      files.length === 0 ||
      !files.every((candidate) => candidate instanceof File)
    ) {
      throw new Error("Select at least one still image file.");
    }
    const service = await getCuratorService();
    const uploads = [];
    for (const file of files as File[]) {
      const result = await service.upload(
        file.name,
        file.type,
        new Uint8Array(await file.arrayBuffer()),
      );
      uploads.push({
        record: clientRecord(result.record),
        duplicate: result.duplicate,
        mediaUrl: `/api/local-media/${result.record.draft.sha256}`,
      });
    }
    return NextResponse.json({ uploads });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Media upload failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
