import { NextResponse } from "next/server";
import { getCuratorService } from "@/lib/curation/container";
import { isLocalFeatureRequest } from "@/lib/curation/local-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECORD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export async function POST(request: Request) {
  if (!isLocalFeatureRequest(request)) {
    return NextResponse.json(
      { error: "The curator API is local-only." },
      { status: 403 },
    );
  }
  try {
    const body: unknown = await request.json();
    const id =
      typeof body === "object" && body !== null && "id" in body
        ? body.id
        : null;
    if (typeof id !== "string" || !RECORD_ID_PATTERN.test(id)) {
      return NextResponse.json(
        { error: "A valid curator record ID is required." },
        { status: 400 },
      );
    }
    const service = await getCuratorService();
    const result = await service.identify(id);
    if (!result) {
      return NextResponse.json(
        { error: "Curator record not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ identification: result.identification });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Artwork lookup failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
