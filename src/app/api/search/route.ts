import { NextResponse } from "next/server";
import { DEFAULT_CHANNEL, isChannel } from "@/lib/catalog/types";
import { getRetrievalService } from "@/lib/retrieval/container";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim();
  if (!query) {
    return NextResponse.json(
      { error: "Add a concept, mood, person, or idea to search." },
      { status: 400 },
    );
  }
  const channelParam = params.get("channel") ?? DEFAULT_CHANNEL;
  if (!isChannel(channelParam)) {
    return NextResponse.json(
      { error: "Unknown search channel." },
      { status: 400 },
    );
  }
  try {
    const service = await getRetrievalService();
    return NextResponse.json(await service.search(query, channelParam));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Semantic search failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
