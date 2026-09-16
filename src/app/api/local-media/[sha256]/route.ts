import { NextResponse } from "next/server";
import { getCuratorService } from "@/lib/curation/container";
import { LocalMediaStore } from "@/lib/curation/local-media-store";
import { isLocalFeatureRequest } from "@/lib/curation/local-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ sha256: string }> },
) {
  if (!isLocalFeatureRequest(request)) {
    return NextResponse.json(
      { error: "Local media is disabled outside local development." },
      { status: 403 },
    );
  }
  const { sha256 } = await context.params;
  if (!SHA256_PATTERN.test(sha256)) {
    return NextResponse.json({ error: "Invalid media digest." }, { status: 400 });
  }
  try {
    const service = await getCuratorService();
    const record = await service.findByHash(sha256);
    if (!record) {
      return NextResponse.json({ error: "Media not found." }, { status: 404 });
    }
    const bytes = await new LocalMediaStore().read(sha256);
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "content-length": String(bytes.byteLength),
        "content-type": record.draft.mimeType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return NextResponse.json({ error: "Media not found." }, { status: 404 });
    }
    throw error;
  }
}
