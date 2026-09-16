import { NextResponse } from "next/server";
import { getCuratorService } from "@/lib/curation/container";
import { LocalMediaStore } from "@/lib/curation/local-media-store";
import { isLocalFeatureRequest } from "@/lib/curation/local-security";
import { LocalThumbnailStore } from "@/lib/curation/thumbnail-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Bounded preview of a local image. Originals can be 15–20 MB; decoding a
 * page of those on the UI thread is what froze the curator. Thumbnails are
 * generated once per digest and cached on disk.
 */
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
    const mediaStore = new LocalMediaStore();
    const thumbnails = new LocalThumbnailStore();
    const thumbnail = await thumbnails.get(sha256, record.draft.mimeType, () =>
      mediaStore.read(sha256),
    );
    if (!thumbnail) {
      // Keep a graceful fallback for legacy records without thumbnails.
      const bytes = await mediaStore.read(sha256);
      return new Response(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        {
          headers: {
            "cache-control": "private, max-age=31536000, immutable",
            "content-type": record.draft.mimeType,
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
    return new Response(
      thumbnail.bytes.buffer.slice(
        thumbnail.bytes.byteOffset,
        thumbnail.bytes.byteOffset + thumbnail.bytes.byteLength,
      ) as ArrayBuffer,
      {
        headers: {
          "cache-control": "private, max-age=31536000, immutable",
          "content-length": String(thumbnail.bytes.byteLength),
          "content-type": thumbnail.mimeType,
          "x-content-type-options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return NextResponse.json({ error: "Media not found." }, { status: 404 });
    }
    throw error;
  }
}
