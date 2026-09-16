import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CuratorIndexRepository } from "./repository";
import type { CuratorIndexRecord } from "./types";

interface IndexFile {
  version: 1;
  records: CuratorIndexRecord[];
}

const withLibraryCategory = (
  record: CuratorIndexRecord,
): CuratorIndexRecord => ({
  ...record,
  draft: {
    ...record.draft,
    associations: record.draft.associations ?? [],
    libraryCategory: record.draft.libraryCategory ?? "artwork",
  },
});

export class LocalCuratorIndexRepository implements CuratorIndexRepository {
  private writeChain = Promise.resolve();

  constructor(
    private readonly filePath =
      process.env.CURATION_INDEX_PATH ??
      path.join(process.cwd(), ".local-data", "curation-index.json"),
  ) {}

  async list(): Promise<CuratorIndexRecord[]> {
    return (await this.read()).records;
  }

  async findById(id: string): Promise<CuratorIndexRecord | null> {
    const index = await this.read();
    return index.records.find((record) => record.draft.id === id) ?? null;
  }

  async findByHash(sha256: string): Promise<CuratorIndexRecord | null> {
    const index = await this.read();
    return (
      index.records.find((record) => record.draft.sha256 === sha256) ?? null
    );
  }

  async upsert(record: CuratorIndexRecord): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const index = await this.read();
      const records = index.records.filter(
        (candidate) => candidate.draft.id !== record.draft.id,
      );
      records.push(record);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: 1, records }, null, 2),
        "utf8",
      );
      await rename(temporaryPath, this.filePath);
    });
    await this.writeChain;
  }

  async remove(id: string): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const index = await this.read();
      const records = index.records.filter(
        (candidate) => candidate.draft.id !== id,
      );
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: 1, records }, null, 2),
        "utf8",
      );
      await rename(temporaryPath, this.filePath);
    });
    await this.writeChain;
  }

  private async read(): Promise<IndexFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("version" in parsed) ||
        parsed.version !== 1 ||
        !("records" in parsed) ||
        !Array.isArray(parsed.records)
      ) {
        throw new Error("Local curation index has an invalid format.");
      }
      const index = parsed as IndexFile;
      return {
        ...index,
        records: index.records.map(withLibraryCategory),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { version: 1, records: [] };
      }
      throw error;
    }
  }
}
