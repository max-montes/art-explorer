import { createHash } from "node:crypto";
import {
  constants,
  copyFile,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class LocalMediaStore {
  constructor(
    private readonly directory =
      process.env.CURATION_MEDIA_PATH ??
      path.join(process.cwd(), ".local-data", "media"),
    private readonly curatedDirectory = process.env.CURATED_MEDIA_PATH,
  ) {}

  async put(bytes: Uint8Array): Promise<{ sha256: string; reused: boolean }> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filePath = this.resolve(sha256);
    await mkdir(this.directory, { recursive: true });
    let reused = false;
    try {
      await stat(filePath);
      reused = true;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
      await writeFile(filePath, bytes, { flag: "wx" });
    }
    return { sha256, reused };
  }

  async read(sha256: string): Promise<Uint8Array> {
    return readFile(this.resolve(sha256));
  }

  async publish(
    sha256: string,
    fileName: string,
    subdirectories: string[] = [],
  ): Promise<string | null> {
    if (!this.curatedDirectory) return null;
    const source = this.resolve(sha256);
    const safeName = this.safeFileName(fileName);
    const safeDirectories = subdirectories.map((segment) =>
      this.safePathSegment(segment),
    );
    const targetDirectory = path.join(
      this.curatedDirectory,
      ...safeDirectories,
    );
    await mkdir(targetDirectory, { recursive: true });

    let destination = path.join(targetDirectory, safeName);
    try {
      const existing = await readFile(destination);
      const existingHash = createHash("sha256").update(existing).digest("hex");
      if (existingHash === sha256) {
        return path.relative(this.curatedDirectory, destination);
      }
      const extension = path.extname(safeName);
      const stem = path.basename(safeName, extension);
      destination = path.join(
        targetDirectory,
        `${stem}-${sha256.slice(0, 8)}${extension}`,
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }

    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }
    }
    return path.relative(this.curatedDirectory, destination);
  }

  async remove(sha256: string, publishedPath?: string): Promise<void> {
    if (this.curatedDirectory && publishedPath) {
      const curatedRoot = path.resolve(this.curatedDirectory);
      const publishedFile = path.resolve(curatedRoot, publishedPath);
      if (!publishedFile.startsWith(`${curatedRoot}${path.sep}`)) {
        throw new Error("Published media path escapes the curated library.");
      }
      try {
        const digest = createHash("sha256")
          .update(await readFile(publishedFile))
          .digest("hex");
        if (digest !== sha256) {
          throw new Error("Published media no longer matches its curator record.");
        }
        await unlink(publishedFile);
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ENOENT")
        ) {
          throw error;
        }
      }
    }
    await this.unlinkIfPresent(this.resolve(sha256));
  }

  private async unlinkIfPresent(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }

  private resolve(sha256: string) {
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error("Invalid media digest.");
    }
    return path.join(this.directory, sha256);
  }

  private safeFileName(fileName: string) {
    const base = path.basename(fileName).trim();
    const sanitized = base.replace(/[\u0000-\u001f/:\\]/g, "_");
    if (!sanitized || sanitized === "." || sanitized === "..") {
      throw new Error("The uploaded file name is invalid.");
    }
    return sanitized;
  }

  private safePathSegment(segment: string) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error("The curated library category is invalid.");
    }
    const sanitized = segment.replace(/[\u0000-\u001f/:\\]/g, "_");
    if (sanitized !== segment) {
      throw new Error("The curated library category is invalid.");
    }
    return sanitized;
  }
}
