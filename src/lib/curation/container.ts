import { getCatalogRuntime } from "@/lib/retrieval/container";
import { WikimediaCommonsIdentifier } from "./identify";
import { LocalCuratorIndexRepository } from "./local-repository";
import { LocalMediaStore } from "./local-media-store";
import { CuratorService } from "./service";
import { NoopCuratorSuggestionProvider } from "./suggestions";

const globalCuration = globalThis as typeof globalThis & {
  curatorService?: Promise<CuratorService>;
};

export function getCuratorService() {
  if (!globalCuration.curatorService) {
    globalCuration.curatorService = getCatalogRuntime().then(
      ({ repository, provider }) =>
        new CuratorService(
          new LocalCuratorIndexRepository(),
          repository,
          new LocalMediaStore(),
          provider,
          new NoopCuratorSuggestionProvider(),
          new WikimediaCommonsIdentifier(),
        ),
    );
  }
  return globalCuration.curatorService;
}
