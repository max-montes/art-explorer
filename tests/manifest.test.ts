import { describe, expect, it } from "vitest";
import {
  approvedManifestEntries,
  parseCurationManifest,
} from "@/lib/catalog/manifest";

const approvedAsset = {
  id: "approved",
  type: "artwork",
  title: "Approved",
  creator: "Curator",
  year: "1900",
  source: {
    provider: "Fixture",
    sourceUrl: "https://example.test/approved",
    license: "Reviewed",
  },
  semantics: {
    concepts: ["reason"],
    moods: ["calm"],
    subjects: ["figure"],
    description: "Description",
    narrative: "Narrative",
  },
};

describe("curation manifests", () => {
  it("imports only explicitly included, complete, license-approved entries", () => {
    const manifest = parseCurationManifest({
      version: 1,
      source_root: "/read-only/source",
      entries: [
        {
          id: "approved",
          source_path: "approved.jpg",
          decision: "include",
          exclusion_reason: null,
          metadata_status: "complete",
          license_review_status: "approved",
          asset: approvedAsset,
        },
        {
          id: "pending",
          source_path: "pending.jpg",
          decision: "include",
          exclusion_reason: null,
          metadata_status: "complete",
          license_review_status: "pending",
          asset: { ...approvedAsset, id: "pending" },
        },
        {
          id: "screenshot",
          source_path: "screenshot.png",
          decision: "exclude",
          exclusion_reason: "Not an artwork",
          metadata_status: "incomplete",
          license_review_status: "pending",
        },
      ],
    });

    expect(approvedManifestEntries(manifest).map((entry) => entry.id)).toEqual([
      "approved",
    ]);
  });

  it("rejects path traversal and unexplained exclusions", () => {
    expect(() =>
      parseCurationManifest({
        version: 1,
        source_root: "/read-only/source",
        entries: [
          {
            id: "escape",
            source_path: "../outside.jpg",
            decision: "exclude",
            exclusion_reason: null,
            metadata_status: "incomplete",
            license_review_status: "pending",
          },
        ],
      }),
    ).toThrow();
  });

  it("quarantines review entries from approved imports", () => {
    const manifest = parseCurationManifest({
      version: 1,
      source_root: "/read-only/source",
      entries: [
        {
          id: "provenance-review",
          source_path: "unclear.jpg",
          decision: "review",
          exclusion_reason: null,
          review_reason: "Creator and provenance are unclear.",
          metadata_status: "incomplete",
          license_review_status: "pending",
        },
      ],
    });

    expect(approvedManifestEntries(manifest)).toEqual([]);
  });

});
