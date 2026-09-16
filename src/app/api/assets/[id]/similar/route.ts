import { NextResponse } from "next/server";
import { getRetrievalService } from "@/lib/retrieval/container";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const service = await getRetrievalService();
    return NextResponse.json(await service.similar(id));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Similar asset search failed.";
    const status = message.startsWith("Asset not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
