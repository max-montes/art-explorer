import { describe, expect, it } from "vitest";
import { mediaPreviewUrl } from "@/lib/media/preview-url";

describe("media preview URLs", () => {
  it("uses a bounded Wikimedia thumbnail instead of the original image", () => {
    expect(
      mediaPreviewUrl(
        "https://upload.wikimedia.org/wikipedia/commons/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg",
      ),
    ).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/960px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg",
    );
  });

  it("routes local media through the cached thumbnail endpoint", () => {
    const digest = "a".repeat(64);
    expect(mediaPreviewUrl(`/api/local-media/${digest}`)).toBe(
      `/api/local-media/${digest}/thumb`,
    );
    // Only the original-bytes path is rewritten; anything else is left alone.
    expect(mediaPreviewUrl("/api/local-media/hash")).toBe(
      "/api/local-media/hash",
    );
    expect(mediaPreviewUrl("https://example.test/art.jpg")).toBe(
      "https://example.test/art.jpg",
    );
  });
});
