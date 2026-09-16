import { NextResponse } from "next/server";
import { analyzeScript } from "@/lib/assistant/script-analyzer";
import { DEFAULT_CHANNEL, isChannel } from "@/lib/catalog/types";
import { getRetrievalService } from "@/lib/retrieval/container";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("text" in body) ||
      typeof body.text !== "string"
    ) {
      throw new Error("A text field is required.");
    }
    const channel =
      "channel" in body && body.channel !== undefined
        ? body.channel
        : DEFAULT_CHANNEL;
    if (!isChannel(channel)) throw new Error("Unknown search channel.");
    const retrieval = await getRetrievalService();
    return NextResponse.json(
      await analyzeScript(body.text, retrieval, channel),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Script analysis failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
