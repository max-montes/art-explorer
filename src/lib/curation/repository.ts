import type { CuratorIndexRecord } from "./types";

export interface CuratorIndexRepository {
  list(): Promise<CuratorIndexRecord[]>;
  findById(id: string): Promise<CuratorIndexRecord | null>;
  findByHash(sha256: string): Promise<CuratorIndexRecord | null>;
  upsert(record: CuratorIndexRecord): Promise<void>;
  remove(id: string): Promise<void>;
}
