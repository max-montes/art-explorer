import type { CuratorDraft, CuratorSuggestions } from "./types";

export interface CuratorSuggestionProvider {
  suggest(draft: CuratorDraft): Promise<CuratorSuggestions>;
}

export class NoopCuratorSuggestionProvider
  implements CuratorSuggestionProvider
{
  async suggest(): Promise<CuratorSuggestions> {
    return { concepts: [], moods: [], subjects: [] };
  }
}
