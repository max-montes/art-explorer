import { NextResponse } from "next/server";
import { getCuratorService } from "@/lib/curation/container";
import { isLocalFeatureRequest } from "@/lib/curation/local-security";
import {
  CurationValidationError,
  DuplicateMediaError,
} from "@/lib/curation/service";
import type { CuratorIndexRecord } from "@/lib/curation/types";
import { parseCuratorDraft } from "@/lib/curation/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const clientRecord = (record: CuratorIndexRecord) => ({
  ...record,
  embedding: {
    status: record.embedding.status,
    provider: record.embedding.provider,
    version: record.embedding.version,
    indexedAt: record.embedding.indexedAt,
  },
});

export async function GET(request: Request) {
  if (!isLocalFeatureRequest(request)) {
    return NextResponse.json(
      { error: "The curator API is local-only." },
      { status: 403 },
    );
  }
  const sha256 = new URL(request.url).searchParams.get("sha256");
  const service = await getCuratorService();
  if (sha256 === null) {
    const records = await service.list();
    return NextResponse.json({ records: records.map(clientRecord) });
  }
  if (!SHA256_PATTERN.test(sha256)) {
    return NextResponse.json(
      { error: "A valid SHA-256 digest is required." },
      { status: 400 },
    );
  }
  const record = await service.findByHash(sha256);
  return NextResponse.json({
    duplicate: record !== null,
    record: record ? clientRecord(record) : null,
  });
}

export async function POST(request: Request) {
  if (!isLocalFeatureRequest(request)) {
    return NextResponse.json(
      { error: "The curator API is local-only." },
      { status: 403 },
    );
  }
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || !("action" in body)) {
      throw new Error("Action and draft are required.");
    }
    const action = body.action;
    if (!("draft" in body)) throw new Error("Draft is required.");
    const draft = parseCuratorDraft(body.draft);
    const service = await getCuratorService();
    const record =
      action === "save"
        ? await service.saveDraft(draft)
        : action === "approve"
          ? await service.approve(draft)
          : null;
    if (!record) throw new Error("Unsupported curator action.");
    return NextResponse.json({ record: clientRecord(record) });
  } catch (error) {
    if (error instanceof CurationValidationError) {
      return NextResponse.json(
        { error: error.message, issues: error.issues },
        { status: 422 },
      );
    }
    if (error instanceof DuplicateMediaError) {
      return NextResponse.json(
        {
          error: error.message,
          issues: [{ field: "duplicate", message: error.message }],
        },
        { status: 409 },
      );
    }
    const message =
      error instanceof Error ? error.message : "Curator action failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isLocalFeatureRequest(request)) {
    return NextResponse.json(
      { error: "The curator API is local-only." },
      { status: 403 },
    );
  }
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !RECORD_ID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: "A valid curator record ID is required." },
      { status: 400 },
    );
  }
  try {
    const service = await getCuratorService();
    const deleted = await service.remove(id);
    if (!deleted) {
      return NextResponse.json(
        { error: "Curator record not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ deletedId: deleted.draft.id });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Curator delete failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
