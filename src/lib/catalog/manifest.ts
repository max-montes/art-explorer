import path from "node:path";
import type { MediaAsset } from "./types";

export type CurationDecision = "include" | "exclude" | "review";
export type MetadataStatus = "complete" | "incomplete";
export type LicenseReviewStatus = "approved" | "pending" | "rejected";

export interface CurationManifestEntry {
  id: string;
  source_path: string;
  decision: CurationDecision;
  exclusion_reason: string | null;
  review_reason?: string | null;
  metadata_status: MetadataStatus;
  license_review_status: LicenseReviewStatus;
  asset?: MediaAsset;
}

export interface CurationManifest {
  version: 1;
  source_root: string;
  entries: CurationManifestEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseCurationManifest(value: unknown): CurationManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.source_root !== "string" ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Manifest must have version 1, source_root, and entries.");
  }

  const sourceRoot = value.source_root;
  const entries = value.entries.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Manifest entry ${index} must be an object.`);
    }
    const {
      id,
      source_path,
      decision,
      exclusion_reason,
      review_reason,
      metadata_status,
      license_review_status,
      asset,
    } = candidate;
    if (
      typeof id !== "string" ||
      typeof source_path !== "string" ||
      (decision !== "include" &&
        decision !== "exclude" &&
        decision !== "review") ||
      (metadata_status !== "complete" && metadata_status !== "incomplete") ||
      (license_review_status !== "approved" &&
        license_review_status !== "pending" &&
        license_review_status !== "rejected") ||
      (exclusion_reason !== null && typeof exclusion_reason !== "string") ||
      (review_reason !== undefined &&
        review_reason !== null &&
        typeof review_reason !== "string")
    ) {
      throw new Error(`Manifest entry ${index} has invalid review fields.`);
    }
    if (path.isAbsolute(source_path)) {
      throw new Error(
        `Manifest entry ${id} must use a source_path relative to source_root.`,
      );
    }
    const resolvedRoot = path.resolve(sourceRoot);
    const resolvedSource = path.resolve(resolvedRoot, source_path);
    if (!resolvedSource.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Manifest entry ${id} escapes source_root.`);
    }
    if (decision === "exclude" && !exclusion_reason) {
      throw new Error(`Excluded entry ${id} requires exclusion_reason.`);
    }
    if (decision === "include" && exclusion_reason !== null) {
      throw new Error(`Included entry ${id} cannot have exclusion_reason.`);
    }
    if (decision === "review" && !review_reason) {
      throw new Error(`Review entry ${id} requires review_reason.`);
    }
    if (
      decision === "include" &&
      metadata_status === "complete" &&
      license_review_status === "approved" &&
      !isRecord(asset)
    ) {
      throw new Error(
        `Import-ready entry ${id} requires complete asset metadata.`,
      );
    }
    const entry: CurationManifestEntry = {
      id,
      source_path,
      decision,
      exclusion_reason,
      review_reason:
        typeof review_reason === "string" ? review_reason : null,
      metadata_status,
      license_review_status,
      asset: asset as MediaAsset | undefined,
    };
    return entry;
  });

  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("Manifest entry ids must be unique.");
  }
  return {
    version: 1,
    source_root: sourceRoot,
    entries,
  };
}

export function approvedManifestEntries(manifest: CurationManifest) {
  return manifest.entries.filter(
    (
      entry,
    ): entry is CurationManifestEntry & {
      decision: "include";
      asset: MediaAsset;
    } =>
      entry.decision === "include" &&
      entry.metadata_status === "complete" &&
      entry.license_review_status === "approved" &&
      entry.asset !== undefined,
  );
}
