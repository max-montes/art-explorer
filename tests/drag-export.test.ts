import { describe, expect, it } from "vitest";
import type { MediaAsset } from "@/lib/catalog/types";
import { mediaDragFile } from "@/lib/media/drag-export";

const fixture = (mediaUrl?: string): MediaAsset => ({
  id: "fixture",
  type: "artwork",
  title: "L'École d'Athènes",
  creator: "Raphaël",
  year: "1511",
  source: {
    provider: "Fixture",
    sourceUrl: "https://example.test",
    mediaUrl,
    license: "Fixture",
  },
  semantics: {
    concepts: ["reason"],
    moods: ["harmony"],
    subjects: ["Plato"],
    description: "Fixture",
    narrative: "Fixture",
  },
});

describe("media drag export", () => {
  it("produces an editor-compatible filename and MIME type", () => {
    expect(mediaDragFile(fixture("/api/local-media/hash?format=png"))).toEqual({
      url: "/api/local-media/hash?format=png",
      mimeType: "image/jpeg",
      fileName: "Raphael-L-Ecole-d-Athenes.jpg",
    });

    expect(mediaDragFile(fixture("https://example.test/frame.webp?raw=1"))).toEqual({
      url: "https://example.test/frame.webp?raw=1",
      mimeType: "image/webp",
      fileName: "Raphael-L-Ecole-d-Athenes.webp",
    });
  });

  it("does not create a drag payload without media bytes", () => {
    expect(mediaDragFile(fixture())).toBeNull();
  });
});
