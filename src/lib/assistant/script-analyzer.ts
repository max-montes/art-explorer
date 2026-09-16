import {
  assetAssociations,
  DEFAULT_CHANNEL,
  type Channel,
  type ScriptAnalysis,
  type ScriptPassage,
  type ScoredAsset,
} from "@/lib/catalog/types";

export interface PassageSearch {
  search(
    query: string,
    channel: Channel,
    limit?: number,
  ): Promise<{ results: ScoredAsset[] }>;
  recommendForScript(
    passages: string[],
    channel: Channel,
    limit?: number,
  ): Promise<{ results: ScoredAsset[] }>;
}

interface TextSpan {
  start: number;
  end: number;
  text: string;
}

const MAX_SCRIPT_LENGTH = 12_000;
const MAX_PASSAGES = 32;
const MIN_PASSAGE_LENGTH = 3;
const MAX_PASSAGE_LENGTH = 160;

const unique = (values: string[], limit: number) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(
    0,
    limit,
  );

export function segmentScript(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  const pattern = /[^\n.!?;]+(?:[.!?;]+["'”’)\]]*|(?=\n)|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const leading = match[0].match(/^\s*/)?.[0].length ?? 0;
    const trailing = match[0].match(/\s*$/)?.[0].length ?? 0;
    let start = match.index + leading;
    const matchEnd = match.index + match[0].length - trailing;
    while (matchEnd - start > MAX_PASSAGE_LENGTH) {
      const window = text.slice(start, start + MAX_PASSAGE_LENGTH + 1);
      const boundaries = [...window.matchAll(/[,—:]\s+/g)].filter(
        (boundary) => (boundary.index ?? 0) >= 60,
      );
      const boundary = boundaries.at(-1);
      const splitAt =
        boundary?.index !== undefined
          ? start + boundary.index + boundary[0].trimEnd().length
          : start + window.lastIndexOf(" ");
      if (splitAt <= start) break;
      spans.push({
        start,
        end: splitAt,
        text: text.slice(start, splitAt),
      });
      start = splitAt;
      while (start < matchEnd && /\s/.test(text[start])) start += 1;
      if (spans.length >= MAX_PASSAGES) return spans;
    }
    if (matchEnd - start >= MIN_PASSAGE_LENGTH) {
      spans.push({
        start,
        end: matchEnd,
        text: text.slice(start, matchEnd),
      });
    }
    if (spans.length >= MAX_PASSAGES) return spans;
  }
  return spans;
}

const associationsFrom = (results: ScoredAsset[]) =>
  unique(
    results.slice(0, 3).flatMap((result) => assetAssociations(result.asset)),
    8,
  );

export async function analyzeScript(
  text: string,
  retrieval: PassageSearch,
  channel: Channel = DEFAULT_CHANNEL,
): Promise<ScriptAnalysis> {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) throw new Error("Paste a script or set of words.");
  if (normalized.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `Script is too long. Keep it under ${MAX_SCRIPT_LENGTH.toLocaleString()} characters.`,
    );
  }
  const spans = segmentScript(normalized);
  if (spans.length === 0) {
    throw new Error("No searchable passages were found.");
  }

  const passages = await Promise.all(
    spans.map(async (span, index): Promise<ScriptPassage> => {
      const { results } = await retrieval.search(span.text, channel, 6);
      return {
        id: `passage-${index + 1}`,
        ...span,
        associations: associationsFrom(results),
        results,
      };
    }),
  );
  return { text: normalized, channel, passages };
}
