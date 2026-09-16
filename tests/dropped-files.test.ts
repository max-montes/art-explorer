import { describe, expect, it } from "vitest";
import {
  filesFromDrop,
  hasFilePayload,
  isSupportedCuratorFile,
} from "@/lib/curation/dropped-files";

const fileEntry = (file: File): FileSystemEntry =>
  ({
    isFile: true,
    isDirectory: false,
    file: (success: (value: File) => void) => success(file),
  }) as FileSystemFileEntry;

const directoryEntry = (entries: FileSystemEntry[]): FileSystemEntry =>
  ({
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let delivered = false;
      return {
        readEntries: (success: (values: FileSystemEntry[]) => void) => {
          if (delivered) success([]);
          else {
            delivered = true;
            success(entries);
          }
        },
      };
    },
  }) as FileSystemDirectoryEntry;

describe("folder drops", () => {
  it("recursively collects nested files", async () => {
    const image = new File(["image"], "art.png", { type: "image/png" });
    const legacyMedia = new File(["media"], "legacy.mp3", { type: "audio/mpeg" });
    const root = directoryEntry([
      fileEntry(image),
      directoryEntry([fileEntry(legacyMedia)]),
    ]);
    const transfer = {
      items: [{ webkitGetAsEntry: () => root }],
      files: [],
    } as unknown as DataTransfer;

    expect((await filesFromDrop(transfer)).map((file) => file.name)).toEqual([
      "art.png",
      "legacy.mp3",
    ]);
  });

  it("accepts artwork images but rejects unrelated files", () => {
    expect(
      [
        new File([], "art.jpg", { type: "image/jpeg" }),
        new File([], "legacy.wav", { type: "audio/wav" }),
        new File([], "legacy.mov", { type: "media/quicktime" }),
        new File([], "notes.txt", { type: "text/plain" }),
      ].filter(isSupportedCuratorFile).map((file) => file.name),
    ).toEqual(["art.jpg"]);
  });

  it("distinguishes OS file drops from internal media drags", () => {
    expect(
      hasFilePayload({ types: ["Files"] } as unknown as DataTransfer),
    ).toBe(true);
    expect(
      hasFilePayload({
        types: ["text/plain", "text/uri-list"],
      } as unknown as DataTransfer),
    ).toBe(false);
  });
});
